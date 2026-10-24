# Cloud Play input helper for Windows (kept ASCII-only on purpose: PowerShell 5 reads files in the ANSI code page).
# Reads commands line by line from stdin and sends them to the system with SendInput.
#   m dx dy   - move mouse relatively
#   a x y     - move mouse to absolute point (0..65535 of the primary screen)
#   d b / u b - mouse button down / up (0 left, 1 right, 2 middle, 3 and 4 side buttons)
#   w n / h n - vertical / horizontal wheel
#   k s / K s - key down / up by scan code (0xE0xx means extended key)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class CloudPlayInput {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  static readonly int Size = Marshal.SizeOf(typeof(INPUT));
  static readonly uint[] Down = { 0x0002, 0x0008, 0x0020, 0x0080, 0x0080 };
  static readonly uint[] Up   = { 0x0004, 0x0010, 0x0040, 0x0100, 0x0100 };

  static void Mouse(int dx, int dy, uint data, uint flags) {
    var i = new INPUT[1];
    i[0].type = 0;
    i[0].u.mi.dx = dx; i[0].u.mi.dy = dy; i[0].u.mi.mouseData = data; i[0].u.mi.dwFlags = flags;
    SendInput(1, i, Size);
  }

  static void Key(int code, bool up) {
    var i = new INPUT[1];
    i[0].type = 1;
    i[0].u.ki.wScan = (ushort)(code & 0xFF);
    uint flags = 0x0008; // KEYEVENTF_SCANCODE
    if ((code & 0xFF00) == 0xE000) flags |= 0x0001; // KEYEVENTF_EXTENDEDKEY
    if (up) flags |= 0x0002; // KEYEVENTF_KEYUP
    i[0].u.ki.dwFlags = flags;
    SendInput(1, i, Size);
  }

  public static void Run() {
    SetProcessDPIAware();
    var reader = new StreamReader(Console.OpenStandardInput());
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    string line;
    while ((line = reader.ReadLine()) != null) {
      try {
        var p = line.Split(' ');
        if (p.Length < 2) continue;
        int a = int.Parse(p[1]);
        int b = p.Length > 2 ? int.Parse(p[2]) : 0;
        switch (p[0]) {
          case "m": Mouse(a, b, 0, 0x0001); break;
          case "a": Mouse(a, b, 0, 0x0001 | 0x8000); break;
          case "d": if (a >= 0 && a < 5) Mouse(0, 0, a == 3 ? 1u : a == 4 ? 2u : 0u, Down[a]); break;
          case "u": if (a >= 0 && a < 5) Mouse(0, 0, a == 3 ? 1u : a == 4 ? 2u : 0u, Up[a]); break;
          case "w": Mouse(0, 0, unchecked((uint)a), 0x0800); break;
          case "h": Mouse(0, 0, unchecked((uint)a), 0x1000); break;
          case "k": Key(a, false); break;
          case "K": Key(a, true); break;
        }
      } catch (Exception) { }
    }
  }
}
"@
[CloudPlayInput]::Run()
