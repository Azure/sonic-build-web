#!/bin/bash

set -ex
mkdir -p /data/workspace/daemon /workspace
rm -rf /data/workspace/daemon/* -rf
apt-get update
apt-get install git jq gh parallel -y
git config --global --add safe.directory '*'