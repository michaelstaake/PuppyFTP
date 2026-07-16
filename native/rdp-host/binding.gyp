{
  "targets": [
    {
      "target_name": "rdp_host",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": ["src/rdp_host.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["shell32.lib", "user32.lib", "gdi32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/EHsc"]
              }
            }
          },
          {
            "type": "none"
          }
        ]
      ]
    }
  ]
}
