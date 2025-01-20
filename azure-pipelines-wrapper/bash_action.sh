#!/bin/bash

# input FOLDER REPO SCRIPT_URL
cd /workspace
tmpfile=$(mktemp)
for i in "$@";do
    echo $i >> $tmpfile
done
. $tmpfile

mkdir $FOLDER-$REPO -p
cd $FOLDER-$REPO
tmp=$(mktemp -p ./ -d)
cd $tmp
echo "tmp dir: $tmp"
mv $tmpfile .bashenv

curl "$SCRIPT_URL" -o script.sh -L
chmod +x script.sh
./script.sh 2>&1 | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> error.log; done

rc=${PIPESTATUS[0]}
echo "Exit Code: $rc" >> error.log
echo "Exit Code: $rc" >> log.log
sync error.log log.log
cat log.log
folders=$(ls -l | grep ^d | awk '{print$NF}')
[ -n $folders ] && tar -czf folders.tar.gz $folders --remove-files
cd ..
mv $tmp /data/workspace/$FOLDER-$REPO/
exit $rc
