param(
  [string]$Mode = "files",
  [string]$InitialDir = "",
  [string]$OutputFile = ""
)

# 用 Windows 的「通用项目对话框」（IFileOpenDialog）而不是旧式 comdlg32 对话框：
# 外观与资源管理器一致（面包屑、现代工具栏、新建文件夹、左侧导航），
# 文件夹模式用 FOS_PICKFOLDERS，文件模式支持多选。
# 必须先 SetProcessDPIAware，否则高缩放下对话框会被位图拉伸、发虚。

$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
internal class FileOpenDialog { }

// 注意 IID：必须具备 IFileOpenDialog 的 IID（d57c7288-…），而不能用 IFileDialog 的
// 42f85136-…。两个接口的 vtable 前 24 个方法一样，但 GetResults / GetSelectedItems
// 是 IFileOpenDialog 才有的第 25、26 个槽；如果声明成 IFileDialog 的 GUID，取消时
// 看不出问题（不碰这两个方法），一旦点「打开」确定，调用 GetResults 就会踩到非法槽位，
// PowerShell 抛异常 → 结果文件没写 → host 当成「用户取消」→ 面板显示「没有选择文件」。
[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOpenDialog
{
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName(out IntPtr pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IShellItemArray ppenum);
    void GetSelectedItems(out IShellItemArray ppsai);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItemArray
{
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    void GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
    void GetCount(out uint pdwNumItems);
    void GetItemAt(uint dwIndex, out IShellItem ppsi);
    void EnumItems(out IntPtr ppenumShellItems);
}

public static class DeskPicker
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_ALLOWMULTISELECT = 0x00000200;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint FOS_FILEMUSTEXIST = 0x00001000;
    private const uint SIGDN_FILESYSPATH = 0x80058000;

    public static string[] Pick(string mode, string initialDir, string title)
    {
        SetProcessDPIAware();

        bool folderMode = string.Equals(mode, "folder", StringComparison.OrdinalIgnoreCase);
        // 用 CLSID 晚绑定拿 COM 对象，再 QI 到 IFileOpenDialog（IID d57c7288）。
        // 不要写成 (IFileOpenDialog)new FileOpenDialog()：那样用的是 ComImport 类的强转路径，
        // 一旦 IID 不对就会在点「打开」确定后抛异常，表现成「点了确认却什么也没选中」。
        object comObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")));
        var dialog = (IFileOpenDialog)comObject;

        uint options = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
        options |= folderMode ? FOS_PICKFOLDERS : (FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST);
        dialog.SetOptions(options);
        if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);

        if (!string.IsNullOrEmpty(initialDir) && System.IO.Directory.Exists(initialDir))
        {
            try
            {
                var iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                IShellItem start;
                SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out start);
                if (start != null) dialog.SetFolder(start);
            }
            catch (Exception) { }
        }

        int hr = dialog.Show(IntPtr.Zero);
        if (hr != 0) return new string[0];

        var results = new List<string>();
        if (folderMode)
        {
            IShellItem item;
            dialog.GetResult(out item);
            string path = DisplayPath(item);
            if (!string.IsNullOrEmpty(path)) results.Add(path);
        }
        else
        {
            IShellItemArray array;
            dialog.GetResults(out array);
            uint count;
            array.GetCount(out count);
            for (uint index = 0; index < count; index++)
            {
                IShellItem item;
                array.GetItemAt(index, out item);
                string path = DisplayPath(item);
                if (!string.IsNullOrEmpty(path)) results.Add(path);
            }
        }
        return results.ToArray();
    }

    private static string DisplayPath(IShellItem item)
    {
        if (item == null) return null;
        IntPtr pointer;
        item.GetDisplayName(SIGDN_FILESYSPATH, out pointer);
        try { return Marshal.PtrToStringUni(pointer); }
        finally { if (pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pointer); }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$title = if ($Mode -eq "folder") { "选择要作为 DSH 项目的文件夹" } else { "选择要带进这个项目的文件（可多选）" }
$paths = [DeskPicker]::Pick($Mode, $InitialDir, $title)
$text = ($paths -join ([Environment]::NewLine))
[System.IO.File]::WriteAllText($OutputFile, $text, (New-Object System.Text.UTF8Encoding($false)))
