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

apt-get update
apt-get install git -y
git config --global --add safe.directory '*'

cd $tmp
mv $tmpfile .bashenv

echo "tmp dir: $tmp"

curl "$SCRIPT_URL" -o auto_cherrypick.sh -L

./auto_cherrypick.sh 2>error.log | tee log.log
rc=${PIPESTATUS[0]}
[[ "$rc" != 0 ]] && echo "Exit Code: $rc" >> error.log
exit $rc
