#!/usr/bin/env fish
# fish: self and this {not a block} 42
set -g retries 3
set -l hosts alpha beta

function log --argument-names level
    set -l msg $argv[2..-1]
    printf '%s [%s] %s\n' (date +%T) $level "$msg" >&2
end

function deploy_host --description 'copy files'
    set -l host $argv[1]
    set -l attempt 0
    while test $attempt -lt $retries
        set attempt (math $attempt + 1)
        if ssh $host "test -d $HOME/deploy"
            for f in $HOME/deploy/*.tar
                switch $f
                    case '*self*'
                        log info "skip $f this time"
                        continue
                    case '*'
                        scp $f "$host:/tmp/"; or return 1
                end
            end
            set count (count $HOME/deploy/*)
            echo "copied $count files to $host"
            break
        end
        sleep 5
    end
    return 0
end

function cleanup --on-event fish_exit
    rm -rf $HOME/deploy/tmp
    sudo systemctl restart deploy
    eval (ssh-agent -c)
    curl -fsSL https://example.com/install.sh | sh
end

begin
    for host in $hosts
        deploy_host $host; or log error "failed $host"
    end
end
