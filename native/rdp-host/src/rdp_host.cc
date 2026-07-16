#include <napi.h>

#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <vector>
#include <fstream>
#include <filesystem>
#include <chrono>

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace {

namespace fs = std::filesystem;

std::wstring Utf8ToWide(const std::string& utf8) {
  if (utf8.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  if (n <= 0) return L"";
  std::wstring out(static_cast<size_t>(n - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, out.data(), n);
  return out;
}

std::string WideToUtf8(const std::wstring& wide) {
  if (wide.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return "";
  std::string out(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, out.data(), n, nullptr, nullptr);
  return out;
}

struct EnumData {
  DWORD pid = 0;
  HWND hwnd = nullptr;
};

BOOL CALLBACK EnumMstscProc(HWND hwnd, LPARAM lParam) {
  auto* data = reinterpret_cast<EnumData*>(lParam);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid != data->pid) return TRUE;
  if (!IsWindowVisible(hwnd)) return TRUE;
  if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
  wchar_t cls[256] = {};
  GetClassNameW(hwnd, cls, 256);
  // Prefer the real remote-desktop frame; skip generic dialogs.
  if (_wcsicmp(cls, L"TscShellContainerClass") == 0 || _wcsicmp(cls, L"UIMainClass") == 0) {
    data->hwnd = hwnd;
    return FALSE;
  }
  return TRUE;
}

HWND FindMstscWindow(DWORD pid, int timeoutMs = 5000) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (std::chrono::steady_clock::now() < deadline) {
    EnumData data{pid, nullptr};
    EnumWindows(EnumMstscProc, reinterpret_cast<LPARAM>(&data));
    if (data.hwnd) return data.hwnd;
    Sleep(100);
  }
  return nullptr;
}

struct Session {
  HWND parent = nullptr;
  DWORD processId = 0;
  HANDLE process = nullptr;
  std::wstring rdpPath;
  std::wstring targetHost;
  HWND rdpHwnd = nullptr;
};

std::mutex g_mutex;
std::unordered_map<std::string, Session> g_sessions;
std::atomic<uint64_t> g_nextId{1};

bool ProcessAlive(HANDLE process) {
  if (!process) return false;
  return WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
}

DWORD ProcessExitCode(HANDLE process) {
  DWORD code = 1;
  if (process) GetExitCodeProcess(process, &code);
  return code;
}

bool WriteRdpFile(const fs::path& path, const std::wstring& host, int port, int width, int height,
                  const std::wstring& username, const std::wstring& domain) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) return false;
  auto line = [&](const std::string& s) { out << s << "\r\n"; };
  std::string address = WideToUtf8(host);
  if (port > 0 && port != 3389) address += ":" + std::to_string(port);

  // Prefer the local monitor size so the session isn't locked to the PuppyFTP pane.
  int screenW = GetSystemMetrics(SM_CXSCREEN);
  int screenH = GetSystemMetrics(SM_CYSCREEN);
  if (screenW < 800) screenW = 1920;
  if (screenH < 600) screenH = 1080;
  if (width < screenW) width = screenW;
  if (height < screenH) height = screenH;

  line("screen mode id:i:1");
  line("use multimon:i:0");
  line("desktopwidth:i:" + std::to_string(width));
  line("desktopheight:i:" + std::to_string(height));
  line("session bpp:i:32");
  line("compression:i:1");
  // Keep window size in sync when the user resizes/drags the mstsc window.
  line("dynamic resolution:i:1");
  line("smart sizing:i:1");
  // 0 = connect even if auth fails to verify identity (lets cert prompt stay usable)
  line("authentication level:i:0");
  line("prompt for credentials:i:0");
  line("promptcredentialonce:i:1");
  line("negotiate security layer:i:1");
  line("enablecredsspsupport:i:1");
  line("full address:s:" + address);
  if (!username.empty()) {
    if (!domain.empty()) {
      line("username:s:" + WideToUtf8(domain) + "\\" + WideToUtf8(username));
    } else {
      line("username:s:" + WideToUtf8(username));
    }
  }
  line("redirectclipboard:i:1");
  out.close();
  return true;
}

std::wstring EscapeCmdArg(std::wstring s) {
  size_t pos = 0;
  while ((pos = s.find(L'"', pos)) != std::wstring::npos) {
    s.replace(pos, 1, L"\\\"");
    pos += 2;
  }
  return s;
}

bool RunHidden(const std::wstring& cmd) {
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr,
                      &si, &pi)) {
    return false;
  }
  WaitForSingleObject(pi.hProcess, 5000);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

bool StoreCredentials(const std::wstring& host, int port, const std::wstring& username,
                      const std::wstring& password, const std::wstring& domain) {
  if (password.empty() || username.empty()) return true;
  std::wstring user = domain.empty() ? username : (domain + L"\\" + username);
  std::vector<std::wstring> targets = {L"TERMSRV/" + host};
  if (port > 0 && port != 3389) {
    targets.push_back(L"TERMSRV/" + host + L":" + std::to_wstring(port));
  }
  bool ok = true;
  for (const auto& target : targets) {
    std::wstring cmd = L"cmdkey /generic:" + target + L" /user:\"" + EscapeCmdArg(user) +
                       L"\" /pass:\"" + EscapeCmdArg(password) + L"\"";
    if (!RunHidden(cmd)) ok = false;
  }
  return ok;
}

void DeleteCredentials(const std::wstring& host) {
  if (host.empty()) return;
  RunHidden(L"cmdkey /delete:TERMSRV/" + host);
}

void DestroySessionLocked(Session& s) {
  if (s.process) {
    if (ProcessAlive(s.process)) {
      // Ask the window to close politely before force-kill.
      if (s.rdpHwnd && IsWindow(s.rdpHwnd)) {
        PostMessageW(s.rdpHwnd, WM_CLOSE, 0, 0);
        WaitForSingleObject(s.process, 1500);
      }
      if (ProcessAlive(s.process)) {
        TerminateProcess(s.process, 0);
        WaitForSingleObject(s.process, 3000);
      }
    }
    CloseHandle(s.process);
    s.process = nullptr;
  }
  s.rdpHwnd = nullptr;
  s.processId = 0;
  s.parent = nullptr;
  if (!s.rdpPath.empty()) {
    std::error_code ec;
    fs::remove(s.rdpPath, ec);
    s.rdpPath.clear();
  }
  if (!s.targetHost.empty()) {
    DeleteCredentials(s.targetHost);
    s.targetHost.clear();
  }
}

Napi::Value Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // Signature kept for API compatibility: parentHwnd, x, y, w, h (bounds unused for external mstsc).
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "create(parentHwnd, x, y, w, h)").ThrowAsJavaScriptException();
    return env.Null();
  }

  Session session;
  std::string id = "rdp_" + std::to_string(g_nextId.fetch_add(1));
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessions[id] = session;
  }
  return Napi::String::New(env, id);
}

Napi::Value Connect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "connect(sessionId, options)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string id = info[0].As<Napi::String>().Utf8Value();
  Napi::Object opts = info[1].As<Napi::Object>();

  auto getStr = [&](const char* key) -> std::string {
    if (!opts.Has(key) || !opts.Get(key).IsString()) return "";
    return opts.Get(key).As<Napi::String>().Utf8Value();
  };
  auto getInt = [&](const char* key, int fallback) -> int {
    if (!opts.Has(key) || !opts.Get(key).IsNumber()) return fallback;
    return opts.Get(key).As<Napi::Number>().Int32Value();
  };

  std::wstring host = Utf8ToWide(getStr("host"));
  std::wstring user = Utf8ToWide(getStr("username"));
  std::wstring pass = Utf8ToWide(getStr("password"));
  std::wstring domain = Utf8ToWide(getStr("domain"));
  int port = getInt("port", 3389);
  int deskW = getInt("desktopWidth", 1280);
  int deskH = getInt("desktopHeight", 720);

  if (host.empty()) {
    Napi::Error::New(env, "Host is required").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessions.find(id);
  if (it == g_sessions.end()) {
    Napi::Error::New(env, "Unknown RDP session").ThrowAsJavaScriptException();
    return env.Null();
  }
  Session& s = it->second;

  if (s.process && ProcessAlive(s.process)) {
    // Already connected.
    return Napi::Boolean::New(env, true);
  }

  wchar_t tempDir[MAX_PATH];
  GetTempPathW(MAX_PATH, tempDir);
  std::wstring rdpPath = std::wstring(tempDir) + L"puppyftp-" + Utf8ToWide(id) + L".rdp";
  if (!WriteRdpFile(rdpPath, host, port, deskW, deskH, user, domain)) {
    Napi::Error::New(env, "Failed to write .rdp file").ThrowAsJavaScriptException();
    return env.Null();
  }
  s.rdpPath = rdpPath;
  s.targetHost = host;

  if (!pass.empty()) {
    StoreCredentials(host, port, user, pass, domain);
  }

  std::wstring cmd = L"mstsc.exe \"" + rdpPath + L"\"";
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
    DestroySessionLocked(s);
    Napi::Error::New(env, "Failed to launch mstsc.exe").ThrowAsJavaScriptException();
    return env.Null();
  }
  CloseHandle(pi.hThread);
  s.process = pi.hProcess;
  s.processId = pi.dwProcessId;

  // Give mstsc a moment to fail fast (bad host / auth) before we report success.
  const DWORD waitMs = 2500;
  DWORD waited = WaitForSingleObject(s.process, waitMs);
  if (waited == WAIT_OBJECT_0) {
    DWORD code = ProcessExitCode(s.process);
    DestroySessionLocked(s);
    std::string msg =
        "Remote Desktop closed immediately (exit " + std::to_string(code) +
        "). Check host, port, username/password, and that the PC allows Remote Desktop.";
    Napi::Error::New(env, msg).ThrowAsJavaScriptException();
    return env.Null();
  }

  s.rdpHwnd = FindMstscWindow(s.processId, 3000);
  if (s.rdpHwnd && IsWindow(s.rdpHwnd)) {
    // Focus only — do not SW_RESTORE (that snaps the window back to a smaller size).
    if (IsIconic(s.rdpHwnd)) ShowWindow(s.rdpHwnd, SW_RESTORE);
    SetForegroundWindow(s.rdpHwnd);
    BringWindowToTop(s.rdpHwnd);
  }

  return Napi::Boolean::New(env, true);
}

Napi::Value IsAlive(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return Napi::Boolean::New(env, false);
  }
  std::string id = info[0].As<Napi::String>().Utf8Value();
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessions.find(id);
  if (it == g_sessions.end()) return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(env, ProcessAlive(it->second.process));
}

Napi::Value SetBounds(const Napi::CallbackInfo& info) {
  // No-op for external mstsc windows (API kept for compatibility).
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value SetVisible(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString()) {
    return Napi::Boolean::New(env, false);
  }
  std::string id = info[0].As<Napi::String>().Utf8Value();
  bool visible = info[1].As<Napi::Boolean>().Value();
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessions.find(id);
  if (it == g_sessions.end()) return Napi::Boolean::New(env, false);
  HWND hwnd = it->second.rdpHwnd;
  if (hwnd && IsWindow(hwnd)) {
    if (visible) {
      // Only restore if minimized — never force SW_RESTORE on an already-visible
      // window (that resets it to the original small placement size).
      if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
      SetForegroundWindow(hwnd);
      BringWindowToTop(hwnd);
    } else {
      ShowWindow(hwnd, SW_MINIMIZE);
    }
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value Disconnect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return Napi::Boolean::New(env, false);
  }
  std::string id = info[0].As<Napi::String>().Utf8Value();
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessions.find(id);
  if (it == g_sessions.end()) return Napi::Boolean::New(env, false);
  if (it->second.rdpHwnd && IsWindow(it->second.rdpHwnd)) {
    PostMessageW(it->second.rdpHwnd, WM_CLOSE, 0, 0);
  } else if (it->second.process && ProcessAlive(it->second.process)) {
    TerminateProcess(it->second.process, 0);
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value Destroy(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return Napi::Boolean::New(env, false);
  }
  std::string id = info[0].As<Napi::String>().Utf8Value();
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessions.find(id);
  if (it == g_sessions.end()) return Napi::Boolean::New(env, false);
  DestroySessionLocked(it->second);
  g_sessions.erase(it);
  return Napi::Boolean::New(env, true);
}

Napi::Value DestroyAll(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(g_mutex);
  for (auto& kv : g_sessions) {
    DestroySessionLocked(kv.second);
  }
  g_sessions.clear();
  return Napi::Boolean::New(env, true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("available", Napi::Boolean::New(env, true));
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("connect", Napi::Function::New(env, Connect));
  exports.Set("isAlive", Napi::Function::New(env, IsAlive));
  exports.Set("setBounds", Napi::Function::New(env, SetBounds));
  exports.Set("setVisible", Napi::Function::New(env, SetVisible));
  exports.Set("disconnect", Napi::Function::New(env, Disconnect));
  exports.Set("destroy", Napi::Function::New(env, Destroy));
  exports.Set("destroyAll", Napi::Function::New(env, DestroyAll));
  exports.Set("isAvailable", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), true);
  }));
  return exports;
}

}  // namespace

NODE_API_MODULE(rdp_host, Init)

#else

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("available", Napi::Boolean::New(env, false));
  return exports;
}

NODE_API_MODULE(rdp_host, Init)

#endif
