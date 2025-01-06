#!/bin/bash -ex

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
