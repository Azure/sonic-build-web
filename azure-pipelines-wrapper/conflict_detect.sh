#!/bin/bash

REPO=$1
mkdir -p workspace
cd workspace
rm -rf $(find . -maxdepth 2 -name "tmp.*" -type d -ctime +30)
if (( "$(df -h | grep '% /home' | awk '{print$5}' | grep -Eo [0-9]*)" > "60"));then
    rm -rf $(find . -maxdepth 2 -name "tmp.*" -type d -ctime +20) 2>/dev/null
fi

mkdir conflict-$REPO -p
cd conflict-$REPO
tmp=$(mktemp -p ./ -d)
cd $tmp

apt-get update &>> output.log
apt-get install git -y &>> output.log
git config --global --add safe.directory '*' &>> output.log

echo "tmp dir: $tmp"

cat > .bashenv << EOF
URL=$2
GH_TOKEN=$3
MSAZURE_TOKEN=$4
SCRIPT_URL=$5
PR_OWNER=$6
PR_ID=$7
BASE_BRANCH=$8
USER=$(whoami)
EOF

. .bashenv

curl "https://mssonicbld:$GH_TOKEN@$SCRIPT_URL/ms_conflict_detect.sh" -o ms_conflict_detect.sh -L
curl "https://mssonicbld:$GH_TOKEN@$SCRIPT_URL/azdevops_git_api.sh" -o azdevops_git_api.sh -L
./ms_conflict_detect.sh 2>error.log | while IFS= read -r line; do echo "[$(date '+%FT%TZ')] $line" >> log.log; done
rc=${PIPESTATUS[0]}
echo "Exit Code: $rc" >> error.log
echo "Exit Code: $rc" >> log.log
sync error.log log.log
cat log.log
exit $rc
