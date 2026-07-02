#!/bin/bash -ex

# Cap workspace disk usage. Every PR event copies a per-run tmp.* dir into
# /data/workspace/<folder>-<repo>/ (see bash_action.sh) and nothing ever removed
# them, so /data filled up. Prune old per-run dirs on every daemon tick (runs as
# root, ~every 30 min from env_init.js). Retention is tunable: keep 60 days
# normally, drop to 20 days when /data is above 70% full.
# /data and /home are remote mounts (Azure Files NFS / SMB): each find is wrapped
# in `timeout` so a stalled mount can't hang the sweep, and uses
# -ignore_readdir_race to tolerate tmp.* being created/removed concurrently.
for ws in /data/workspace /home/site/wwwroot/workspace; do
    [ -d "$ws" ] && timeout 900 find "$ws" -maxdepth 2 -ignore_readdir_race -name 'tmp.*' -type d -mtime +60 -exec rm -rf {} + || true
done
data_used=$(df --output=pcent /data 2>/dev/null | tr -dc '0-9')
if [ -n "$data_used" ] && [ "$data_used" -gt 70 ]; then
    timeout 900 find /data/workspace -maxdepth 2 -ignore_readdir_race -name 'tmp.*' -type d -mtime +20 -exec rm -rf {} + || true
fi

if (( $(stat --format %s /home/env_init_daemon.stderr)/1000/1000/1000 > 2 )); then
    cd /home
    mv env_init_daemon.stderr env_init_daemon.stderr.back
    split -l 1000000 -d env_init_daemon.stderr.back env_init_daemon.stderr.back
    cd -
fi
exit 0
uuid=$1
echo "$(date '+%FT%TZ') daemon script start!"
cd site/wwwroot/workspace
rm -rf $(find . -maxdepth 2 -name "tmp.*" -type d -ctime +30)

if (( "$(df -h | grep '% /home' | awk '{print$5}' | grep -Eo [0-9]*)" > "60"));then
    rm -rf $(find . -maxdepth 2 -name "tmp.*" -type d -ctime +20)
fi

cd conflict-sonic-buildimage
mkdir -p daemon/$uuid
touch daemon/done
rm -rf daemon/todo daemon/tmp.*

bashenvs=$(find . -maxdepth 2 -name .bashenv -mtime -25 -mmin +120)
cd daemon
for bashenv in $bashenvs; do
    grep FORCE_PUSH=true ../$bashenv || continue
    PR_NUMBER=$(grep PR_NUMBER ../$bashenv | awk -F= '{print$2}')
    TMP_NAME=$(echo $bashenv | awk -F/ '{print$2}')
    TMP_DATE=$(stat ../$bashenv | grep Birth | sed 's/ Birth: //' | awk -F. '{print$1}')
    if grep ^$PR_NUMBER,$TMP_NAME, done; then
        continue
    fi
    if [[ $(gh pr -R sonic-net/sonic-buildimage view $PR_NUMBER --json url,closed --jq .closed) == 'true' ]]; then
        echo $PR_NUMBER,$TMP_NAME,$TMP_DATE,$uuid >> done
        continue
    fi
    mkdir $TMP_NAME
    cp ../$TMP_NAME/.bashenv ../$TMP_NAME/script.sh $TMP_NAME/
    cd $TMP_NAME
    echo ACTION=ms_checker >> .bashenv
    . .bashenv
    ./script.sh 2>stderr 1>stdout
    sed "s/ms_checker.result: /ms_checker.result: $PR_NUMBER=/" stdout
    sleep 1
    cd ..
    if grep success $TMP_NAME/stdout; then
        echo $PR_NUMBER,$TMP_NAME,$TMP_DATE,$uuid >> done
    fi
done
mv tmp.* $uuid/
