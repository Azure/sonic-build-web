#!/bin/bash
#
# provision vmss virtual machine
#

set -ex

sed -i 's/1/0/' /etc/apt/apt.conf.d/20auto-upgrades || true
source /etc/os-release

function install_packages(){
    # install docker
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
    apt-get -o DPkg::Lock::Timeout=600 update
    apt-get -o DPkg::Lock::Timeout=600 install -y docker-ce docker-ce-cli containerd.io
    apt-get -o DPkg::Lock::Timeout=600 install -y make python3-pip
}

for ((i=0;i<3;i++));do
    install_packages && break
    sleep 3
done

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

# echo add tmp user so that AzDevOps user id will be 1002.
# this is needed as sonic-mgmt container has an user id 1001 already
useradd -M sonictmp

# echo creating tmp AzDevOps account
tmpuser=AzDevOps
useradd -m $tmpuser
usermod -a -G docker $tmpuser
usermod -a -G adm $tmpuser
usermod -a -G sudo $tmpuser
echo "$tmpuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/100-$tmpuser
chmod 440 /etc/sudoers.d/100-$tmpuser

# pip3 install docker==6.1.0 requests==2.31.0

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
