param([Parameter(Mandatory = $true)][int]$ParentProcessId)

$ErrorActionPreference = 'Stop'

# A hidden native message window observes the current interactive session only.
# No display, input, lock, sleep, or power-plan setting is changed by this helper.
# https://learn.microsoft.com/en-us/windows/win32/power/power-setting-guids
# https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-powerbroadcast_setting
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace TodoPet {
    public sealed class DisplayPowerWindow : NativeWindow, IDisposable {
        private static readonly Guid SessionDisplayStatus = new Guid("2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5");
        private IntPtr notification;
        private readonly Process parent;
        private readonly Timer parentWatch;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnregisterPowerSettingNotification(IntPtr handle);

        public DisplayPowerWindow(int parentProcessId) {
            parent = Process.GetProcessById(parentProcessId);
            // Open and retain the process handle so PID reuse cannot create an orphan.
            IntPtr parentHandle = parent.Handle;
            if (parent.HasExited) throw new InvalidOperationException("Parent process already exited.");
            try {
                // WS_POPUP without WS_VISIBLE: receives notifications, never shows UI.
                CreateHandle(new CreateParams { Caption = "TodoPet.DisplayPowerMonitor", Style = unchecked((int)0x80000000) });
                Guid setting = SessionDisplayStatus;
                notification = RegisterPowerSettingNotification(Handle, ref setting, 0);
                if (notification == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                parentWatch = new Timer { Interval = 1000 };
                parentWatch.Tick += delegate {
                    if (parent.HasExited) Application.ExitThread();
                };
                parentWatch.Start();
            } catch {
                Dispose();
                throw;
            }
        }

        protected override void WndProc(ref Message message) {
            const int WM_POWERBROADCAST = 0x0218;
            const int PBT_POWERSETTINGCHANGE = 0x8013;
            if (message.Msg == WM_POWERBROADCAST && message.WParam.ToInt64() == PBT_POWERSETTINGCHANGE && message.LParam != IntPtr.Zero) {
                // POWERBROADCAST_SETTING: GUID(16 bytes), DWORD length, byte data[].
                Guid setting = (Guid)Marshal.PtrToStructure(message.LParam, typeof(Guid));
                int dataLength = Marshal.ReadInt32(message.LParam, 16);
                if (setting == SessionDisplayStatus && dataLength >= 4) {
                    int state = Marshal.ReadInt32(message.LParam, 20);
                    string value = state == 0 ? "off" : state == 1 ? "on" : state == 2 ? "dim" : null;
                    if (value != null) {
                        // Also forwards Windows' initial notification after registration.
                        Console.Out.WriteLine("display-power:" + value);
                        Console.Out.Flush();
                    }
                }
                message.Result = new IntPtr(1);
                return;
            }
            base.WndProc(ref message);
        }

        public void Dispose() {
            if (parentWatch != null) parentWatch.Dispose();
            if (notification != IntPtr.Zero) {
                UnregisterPowerSettingNotification(notification);
                notification = IntPtr.Zero;
            }
            if (Handle != IntPtr.Zero) DestroyHandle();
            parent.Dispose();
        }

        public static void Run(int parentProcessId) {
            using (DisplayPowerWindow window = new DisplayPowerWindow(parentProcessId)) {
                Application.Run();
            }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms -Language CSharp
    [TodoPet.DisplayPowerWindow]::Run($ParentProcessId)
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
