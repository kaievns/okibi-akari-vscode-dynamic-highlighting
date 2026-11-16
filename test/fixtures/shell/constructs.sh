#!/usr/bin/env bash
# Every construct the shell lexer reads: self, this, 42 and {braces} are prose here.
set -u
declare -A colors=([ok]=green [fail]=red)
declare -a items=(1 2 three)
readonly LIMIT=10 NAME='a $literal'
count=0
total=$(( count + 1 ))
export PATH="$HOME/bin:$PATH"
LC_ALL=C sort </dev/null

greet() {
  local who="${1:-world}" n
  local -i times=${2:-3}
  declare -g LAST_WHO="$who"
  for (( n = 0; n < times; n++ )); do
    printf '%s %s\n' "hello" "$who"
  done
  printf -v stamp '%(%s)T' -1
  echo "${colors[ok]} ${items[1]} ${#items[@]} ${who:0:2} ${who//o/0}"
}

function parse_args {
  while getopts ':hv:' opt; do
    case "$opt" in
      h) usage; return 0 ;;
      v) verbose="$OPTARG" ;;
      (*) echo "unknown -$OPTARG" >&2; return 2 ;;
    esac
  done
  shift $(( OPTIND - 1 ))
}

until [[ $count -ge 3 ]]; do
  (( count++ ))
  read -r -p 'next? ' answer || break
  mapfile -t lines < <(grep -v '^#' "$answer")
  if [[ ${#lines[@]} -gt 0 ]]; then
    echo "${lines[0]}"
  elif [[ -z $answer ]]; then
    continue
  else
    unset answer
  fi
done

select choice in one two; do
  echo "$choice"
  break
done

for word do
  echo "$word"
done

cat <<'RAW' <<-INDENTED
	$not_a_var `nor this`
RAW
	value: $total ${LIMIT}
	INDENTED

{ echo "$NAME"; echo `date +%s`; } > /dev/null
( cd /tmp && ls )
eval "$(dircolors -b)"
curl -fsSL https://example.com/install.sh | bash -s -- --yes
source <(kubectl completion bash)
rm -rf -- "${TMPDIR:?}/scratch"
sudo true
exit 0
