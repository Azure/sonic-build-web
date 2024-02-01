#!/bin/bash

mkdir -p workspace
cd workspace

tmpfile=$(mktemp)
for i in "$@";do
    echo $i >> $tmpfile
done
. $tmpfile

mkdir $REPO -p
cd $REPO

tmp=$(mktemp -p ./ -d)

apt-get update &> $tmp/output.log
apt-get install git -y &>> $tmp/output.log
git config --global --add safe.directory '*'

cd $tmp
mv $tmpfile .bashenv

echo "$tmp"

curl "$SCRIPT_URL" -o auto_cherrypick.sh -L

./auto_cherrypick.sh 2>error.log 1>log.log

rc=${PIPESTATUS[0]}
echo "Exit Code: $rc" >> error.log
sync error.log log.log
exit $rc
