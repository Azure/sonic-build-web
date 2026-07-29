#!/bin/bash
#
# provision vmss virtual machine
#

set -ex

sed -i 's/1/0/' /etc/apt/apt.conf.d/20auto-upgrades || true
source /etc/os-release

# install docker
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
apt-get update
NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" -y dist-upgrade

# pin docker version to unblock sonic-swss, sonic-sairedis, and sonic-swss-common VS test
DOCKER_VERSION=$(apt-cache madison docker-ce | awk '{print $3}' | grep -E '29\.5\.0' | head -n1)
if [ -n "$DOCKER_VERSION" ]; then
    echo "Installing docker-ce version $DOCKER_VERSION"
    apt-get install -y docker-ce=$DOCKER_VERSION docker-ce-cli=$DOCKER_VERSION containerd.io
    apt-mark hold docker-ce docker-ce-cli
else
    echo "Docker version 29.5.0 not found, installing the latest version"
    apt-get install -y docker-ce docker-ce-cli containerd.io
fi

apt-get install -y make

# install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# install diff-cover for PR code coverage on the agent
uv pip install --system diff-cover

# install br_netfilter kernel module
modprobe br_netfilter
# set sysctl bridge parameters for testbed
sysctl -w net.bridge.bridge-nf-call-arptables=0
sysctl -w net.bridge.bridge-nf-call-ip6tables=0
sysctl -w net.bridge.bridge-nf-call-iptables=0

# set sysctl RCVBUF default parameter for testbed
sysctl -w net.core.rmem_default=509430500

# enable traffic forward
/usr/sbin/iptables -A FORWARD -j ACCEPT

# enable nat
iptables -t nat -A POSTROUTING -s 10.250.0.0/24 -o eth0 -j MASQUERADE

# create two partition on the 1T data disk
# first partition for azure pipeline agent
# second partition for data
# find data disk, assume it is 1T
datadisk=$(lsblk -d  | grep -E '[[:space:]]1T[[:space:]]' | awk '{print $1}')
sgdisk -n 0:0:500G -t 0:8300 -c 0:agent /dev/$datadisk
sgdisk -n 0:0:0 -t 0:8300 -c 0:data /dev/$datadisk
mkfs.ext4 /dev/${datadisk}1
mkfs.ext4 /dev/${datadisk}2

mkdir /agent
mount /dev/${datadisk}1 /agent
mkdir /data
mount /dev/${datadisk}2 /data

# persist mounts across reboots
echo "UUID=$(blkid -s UUID -o value /dev/${datadisk}1) /agent ext4 defaults,nofail 0 2" >> /etc/fstab
echo "UUID=$(blkid -s UUID -o value /dev/${datadisk}2) /data  ext4 defaults,nofail 0 2" >> /etc/fstab

# echo add tmp user so that AzDevOps user id will be 1002.
# this is needed as sonic-mgmt container has an user id 1001 already
cat /etc/passwd
useradd -M sonictmp

# echo creating tmp AzDevOps account
tmpuser=AzDevOps
useradd -m $tmpuser
usermod -a -G docker $tmpuser
usermod -a -G adm $tmpuser
usermod -a -G sudo $tmpuser
echo "$tmpuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/100-$tmpuser
chmod 440 /etc/sudoers.d/100-$tmpuser

# reboot to apply new kernel if upgraded
if [ -f /var/run/reboot-required ]; then
   echo "Kernel/libs upgraded — rebooting"
   systemctl reboot
fi
