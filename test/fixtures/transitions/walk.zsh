# zshrc fragment
typeset -A aliases_map
aliases_map=(gs 'git status' gd 'git diff')

function prompt_git() {
  local branch
  branch=$(git symbolic-ref --short HEAD 2>/dev/null) || return
  print -n "%F{blue}${branch}%f"
}

() {
  local self=this
  for k v in ${(kv)aliases_map}; do
    alias $k=$v
  done
  echo ${(j:,:)${(k)aliases_map}} $self
}

autoload -Uz compinit && compinit -C
setopt prompt_subst
PROMPT='%~ $(prompt_git) %# '
