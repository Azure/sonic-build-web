#!/bin/bash

mkdir -p workspace
cd workspace

tmpfile=$(mktemp)
for i in "$@";do
    echo $i >> $tmpfile
done
. $tmpfile

mkdir cherrypick-$REPO -p
cd cherrypick-$REPO

tmp=$(mktemp -p ./ -d)

apt-get update &> $tmp/output.log
apt-get install git -y &>> $tmp/output.log
git config --global --add safe.directory '*'

cd $tmp
mv $tmpfile .bashenv

echo "$tmp"

curl "$SCRIPT_URL" -o auto_cherrypick.sh -L

./auto_cherrypick.sh 2>error.log | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> log.log; done

rc=${PIPESTATUS[0]}
echo "Exit Code: $rc" >> error.log
echo "Exit Code: $rc" >> log.log
sync error.log log.log
cat log.log
exit $rc
