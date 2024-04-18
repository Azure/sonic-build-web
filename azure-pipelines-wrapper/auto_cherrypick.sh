#!/bin/bash

mkdir -p workspace
cd workspace
find . -maxdepth 2 -name "tmp.*" -type d -ctime +30 -delete

if (( "$(df -h | grep '% /home' | awk '{print$5}' | grep -Eo [0-9]*)" > "60"));then
    find . -maxdepth 2 -name "tmp.*" -type d -ctime +20 -delete
fi
tmpfile=$(mktemp)
for i in "$@";do
    echo $i >> $tmpfile
done
. $tmpfile

mkdir cherrypick-$REPO -p
cd cherrypick-$REPO
tmp=$(mktemp -p ./ -d)
cd $tmp

apt-get update 2>&1 | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> output.log
apt-get install git jq -y 2>&1 | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> output.log
git config --global --add safe.directory '*' 2>&1 | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> output.log

echo "tmp dir: $tmp"

mv $tmpfile .bashenv

curl "$SCRIPT_URL" -o auto_cherrypick.sh -L 2>&1 | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> output.log
./auto_cherrypick.sh 2>&1 > log.log | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> error.log; done
rc=${PIPESTATUS[0]}
echo "Exit Code: $rc" >> error.log
echo "Exit Code: $rc" >> log.log
sync error.log log.log
cat log.log
exit $rc
