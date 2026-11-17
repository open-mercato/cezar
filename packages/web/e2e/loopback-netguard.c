#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <errno.h>
#include <stdio.h>
static int allowed(const struct sockaddr *a) { if(!a) return 1; if(a->sa_family==AF_INET) return (ntohl(((struct sockaddr_in*)a)->sin_addr.s_addr)>>24)==127; if(a->sa_family==AF_INET6) return IN6_IS_ADDR_LOOPBACK(&((struct sockaddr_in6*)a)->sin6_addr); return a->sa_family==AF_UNIX; }
int connect(int f,const struct sockaddr*a,socklen_t l){if(!allowed(a)){fprintf(stderr,"NETGUARD blocked connect\n");errno=EPERM;return -1;}return ((int(*)(int,const struct sockaddr*,socklen_t))dlsym(RTLD_NEXT,"connect"))(f,a,l);}
ssize_t sendto(int f,const void*b,size_t n,int flags,const struct sockaddr*a,socklen_t l){if(!allowed(a)){fprintf(stderr,"NETGUARD blocked sendto\n");errno=EPERM;return -1;}return ((ssize_t(*)(int,const void*,size_t,int,const struct sockaddr*,socklen_t))dlsym(RTLD_NEXT,"sendto"))(f,b,n,flags,a,l);}
ssize_t sendmsg(int f,const struct msghdr*m,int flags){if(!allowed(m->msg_name)){fprintf(stderr,"NETGUARD blocked sendmsg\n");errno=EPERM;return -1;}return ((ssize_t(*)(int,const struct msghdr*,int))dlsym(RTLD_NEXT,"sendmsg"))(f,m,flags);}
