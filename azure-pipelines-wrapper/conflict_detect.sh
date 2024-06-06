#!/bin/bash

cd workspace
tmpfile=$(mktemp)
for i in "$@";do
    echo $i >> $tmpfile
done
. $tmpfile

mkdir conflict-$REPO -p
cd conflict-$REPO
tmp=$(mktemp -p ./ -d)
cd $tmp
echo "tmp dir: $tmp"
mv $tmpfile .bashenv

curl "https://mssonicbld:$GH_TOKEN@raw.githubusercontent.com/Azure/sonic-pipelines-internal/$SCRIPT_BRANCH/azure-pipelines/$SCRIPT_NAME" -o script.sh -L 2>&1 | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> output.log; done
./script.sh 2>&1 > log.log | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> error.log; done
rc=${PIPESTATUS[0]}
echo "Exit Code: $rc" >> error.log
echo "Exit Code: $rc" >> log.log
sync error.log log.log
cat log.log
exit $rc
