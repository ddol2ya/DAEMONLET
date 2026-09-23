#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>
int wmain(int argc,wchar_t**argv){printf("PID:%lu\n",GetCurrentProcessId());for(int i=1;i<argc;i++){int n=WideCharToMultiByte(CP_UTF8,0,argv[i],-1,nullptr,0,nullptr,nullptr);std::string out(n,0);WideCharToMultiByte(CP_UTF8,0,argv[i],-1,out.data(),n,nullptr,nullptr);printf("ARG:%s\n",out.c_str());}fflush(stdout);Sleep(60000);return 0;}
