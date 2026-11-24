// The environment for a git child process that must act only on the repository its `cwd` (or `-C`) names.
// Git exports GIT_DIR (and, depending on the command, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_PREFIX, GIT_COMMON_DIR, ...) to the hooks it runs. From a linked worktree
// GIT_DIR is an absolute path, so a child git that inherits it ignores its `cwd` and reads or writes the real repository instead: `git init` in a temporary
// directory then sets core.bare on the main repository, test commits land on the branch being pushed and `checkout -b` moves the worktree. Every inherited
// `GIT_*` variable is therefore dropped; `extra` is applied afterwards (for example the author and committer of a temporary repository).
export function isolatedGitEnv(extra={},base=process.env){
 const env={};
 for(const [key,value] of Object.entries(base))if(!/^GIT_/i.test(key))env[key]=value;
 return Object.assign(env,extra);
}
