// Daemonlet's Windows-only owner for a fixed sibling llama-server.exe.
// The non-inherited job handle kills the server on host death; a pipe watches
// Electron's lifetime even when Electron cannot run shutdown handlers.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <cstdio>

static std::wstring quote(const std::wstring &arg) {
    std::wstring out = L"\"";
    size_t slashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') { ++slashes; continue; }
        if (c == L'"') out.append(slashes * 2 + 1, L'\\');
        else out.append(slashes, L'\\');
        out += c; slashes = 0;
    }
    out.append(slashes * 2, L'\\'); out += L'"'; return out;
}
struct Watch { HANDLE input; HANDLE job; };
static DWORD WINAPI watchParent(void *pointer) {
    const auto *watch = static_cast<Watch *>(pointer);
    char buffer[32]; DWORD count;
    while (ReadFile(watch->input, buffer, sizeof(buffer), &count, nullptr) && count) {}
    TerminateJobObject(watch->job, 1);
    return 0;
}
static int fail(const char *stage) {
    std::fprintf(stderr, "daemonlet-runtime-host: %s failed (%lu)\n", stage, GetLastError());
    return 125;
}
int wmain(int argc, wchar_t **argv) {
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (GetFileType(input) != FILE_TYPE_PIPE) return fail("parent lifetime pipe");
    wchar_t module[32768];
    DWORD length = GetModuleFileNameW(nullptr, module, 32768);
    if (!length || length == 32768) return fail("module path");
    std::wstring directory(module, length);
    directory.resize(directory.find_last_of(L"\\/"));
    const std::wstring executable = directory + L"\\llama-server.exe";
    std::wstring command = quote(executable);
    for (int i = 1; i < argc; ++i) command += L" " + quote(argv[i]);
    if (command.size() >= 32767) return fail("command length");
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return fail("create job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { CloseHandle(job); return fail("job limit"); }
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE nullInput = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    if (nullInput == INVALID_HANDLE_VALUE) { CloseHandle(job); return fail("null input"); }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = nullInput;
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    std::vector<HANDLE> inherited{nullInput, startup.StartupInfo.hStdOutput};
    if (startup.StartupInfo.hStdError != startup.StartupInfo.hStdOutput) inherited.push_back(startup.StartupInfo.hStdError);
    for (HANDLE handle : inherited) if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) { CloseHandle(nullInput); CloseHandle(job); return fail("output handle"); }
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    std::vector<unsigned char> storage(bytes);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) { CloseHandle(nullInput); CloseHandle(job); return fail("attribute list"); }
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), inherited.size()*sizeof(HANDLE), nullptr, nullptr)) { DeleteProcThreadAttributeList(startup.lpAttributeList); CloseHandle(nullInput); CloseHandle(job); return fail("handle list"); }
    PROCESS_INFORMATION process{};
    BOOL created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, directory.c_str(), &startup.StartupInfo, &process);
    DeleteProcThreadAttributeList(startup.lpAttributeList); CloseHandle(nullInput);
    if (!created) { CloseHandle(job); return fail("create server"); }
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        TerminateProcess(process.hProcess, 125); WaitForSingleObject(process.hProcess, 5000);
        CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); return fail("assign server job");
    }
    Watch watch{input,job};
    HANDLE watcher = CreateThread(nullptr, 0, watchParent, &watch, 0, nullptr);
    if (!watcher || ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job,125); WaitForSingleObject(process.hProcess,5000);
        CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); return fail("start server");
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 125; GetExitCodeProcess(process.hProcess, &code);
    // ExitProcess ends the blocked pipe watcher before its stack context expires.
    CloseHandle(process.hProcess); CloseHandle(job); CloseHandle(watcher);
    ExitProcess(code);
}
