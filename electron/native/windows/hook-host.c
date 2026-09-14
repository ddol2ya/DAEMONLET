// Native environment boundary for the packaged Windows Hook. No CRT, shell,
// inherited Node options, arbitrary executable argument, or application autostart.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <string.h>
#pragma function(memcpy, memset)
void *memcpy(void *to, const void *from, size_t n) { volatile unsigned char *d=to; const volatile unsigned char *s=from; while(n--) *d++=*s++; return to; }
void *memset(void *to, int value, size_t n) { volatile unsigned char *d=to; while(n--) *d++=(unsigned char)value; return to; }
static WCHAR module[32768], appDir[32768], executable[32768], forwarder[32768];
static WCHAR command[65536], environment[65536], dataDir[8192], endpoint[2048], systemDir[MAX_PATH], windowsDir[MAX_PATH];
static BOOL append(WCHAR *target, DWORD capacity, const WCHAR *value) {
  DWORD a = lstrlenW(target), b = lstrlenW(value);
  if (a + b >= capacity) return FALSE;
  CopyMemory(target + a, value, (b + 1) * sizeof(WCHAR)); return TRUE;
}
static BOOL parent(WCHAR *path) {
  DWORD n = lstrlenW(path); while (n && path[n-1] != L'\\') n--;
  if (n < 4) return FALSE; path[n-1] = 0; return TRUE;
}
static int hex(WCHAR c) { return c >= L'0' && c <= L'9' ? c-L'0' : c >= L'a' && c <= L'f' ? c-L'a'+10 : -1; }
static BOOL decode(const WCHAR *input, WCHAR *output, DWORD capacity) {
  DWORD n = lstrlenW(input); if (!n || n % 4 || n / 4 >= capacity) return FALSE;
  for (DWORD i=0; i<n; i+=4) {
    int value=0; for (int j=0;j<4;j++) { int h=hex(input[i+j]); if(h<0)return FALSE; value=value*16+h; }
    if (value < 32 || value == 127) return FALSE; output[i/4]=(WCHAR)value;
  }
  output[n/4]=0; return TRUE;
}
static BOOL ordinary(const WCHAR *path) { DWORD a=GetFileAttributesW(path); return a!=INVALID_FILE_ATTRIBUTES && !(a & (FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)); }
static BOOL envEntry(DWORD *offset, const WCHAR *key, const WCHAR *value) {
  DWORD n=lstrlenW(key)+lstrlenW(value)+2;
  if (*offset+n+1>=65536) return FALSE;
  WCHAR *item=environment+*offset; lstrcpyW(item,key); lstrcatW(item,L"="); lstrcatW(item,value); *offset+=n; environment[*offset]=0; return TRUE;
}
static void launch(void) {
  int argc=0; WCHAR **argv=CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv || argc!=4 || lstrcmpW(argv[3], L"--daemonlet-codex-pet-adapter=1") || !decode(argv[1],dataDir,8192) || !decode(argv[2],endpoint,2048)) return;
  if (!GetModuleFileNameW(NULL,module,32768) || !parent(module)) return;
  lstrcpyW(forwarder,module); if (!append(forwarder,32768,L"\\hook-forwarder.mjs")) return;
  lstrcpyW(appDir,module); if (!parent(appDir) || !parent(appDir)) return;
  lstrcpyW(executable,appDir); if (!append(executable,32768,L"\\Daemonlet for Codex.exe") || !ordinary(executable) || !ordinary(forwarder)) return;
  if (!GetSystemDirectoryW(systemDir,MAX_PATH) || !GetWindowsDirectoryW(windowsDir,MAX_PATH)) return;
  // Exact fixed paths are quoted; Windows paths cannot contain a quote.
  if (!append(command,65536,L"\"") || !append(command,65536,executable) || !append(command,65536,L"\" \"") || !append(command,65536,forwarder) || !append(command,65536,L"\" --daemonlet-codex-pet-adapter=1")) return;
  DWORD offset=0;
  if (!envEntry(&offset,L"CODEX_PET_DATA_DIR",dataDir) || !envEntry(&offset,L"CODEX_PET_HOOK_TIMEOUT_MS",L"250") || !envEntry(&offset,L"CODEX_PET_HOOK_URL",endpoint) || !envEntry(&offset,L"ELECTRON_RUN_AS_NODE",L"1") || !envEntry(&offset,L"PATH",systemDir) || !envEntry(&offset,L"SystemRoot",windowsDir) || !envEntry(&offset,L"WINDIR",windowsDir)) return;
  SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};
  HANDLE sink=CreateFileW(L"NUL",GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,0,NULL);
  HANDLE input=NULL;
  if (sink==INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_INPUT_HANDLE),GetCurrentProcess(),&input,0,TRUE,DUPLICATE_SAME_ACCESS)) return;
  HANDLE job=CreateJobObjectW(NULL,NULL); if (!job) { CloseHandle(input);CloseHandle(sink);return; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit={0}; limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limit,sizeof(limit))) { CloseHandle(job);CloseHandle(input);CloseHandle(sink);return; }
  STARTUPINFOW si={0}; si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;si.hStdInput=input;si.hStdOutput=sink;si.hStdError=sink;
  PROCESS_INFORMATION pi={0};
  if (CreateProcessW(executable,command,NULL,NULL,TRUE,CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW|CREATE_SUSPENDED,environment,appDir,&si,&pi)) {
    if (AssignProcessToJobObject(job,pi.hProcess)) { ResumeThread(pi.hThread); WaitForSingleObject(pi.hProcess,1700); }
    TerminateJobObject(job,0); TerminateProcess(pi.hProcess,0);
    WaitForSingleObject(pi.hProcess,200); CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
  }
  CloseHandle(job);CloseHandle(input);CloseHandle(sink);
}
void entry(void) {
  SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX);
  launch(); DWORD written=0; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),"{}\n",3,&written,NULL); ExitProcess(0);
}
