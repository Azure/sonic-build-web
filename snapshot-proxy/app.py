from flask import Flask, redirect, request
import re

app = Flask(__name__)

# Define a simple redirect rule
@app.route('/debian-snapshot/<path:target>')
def redirect_to_target(target):
    # Construct the destination URL
    cleaned = re.sub(r'/ts/[^/]+', '', target)
    destination = f'http://packages.trafficmanager.net/debian-snapshot/{cleaned}'

    return redirect(destination, code=302)

@app.route('/snapshot/<path:target>')
def redirect_to_target_a(target):
    # debian/20250910T001830Z/dists/bookworm/main/binary-amd64/Packages   ->   debian/ts/20250910T001830Z/dists/bookworm/main/binary-amd64/Packages
    # debian/20250910T001830Z/pool/main/0/0ad/0ad-dbg_0.0.17-1_amd64.deb   ->   debian/pool/main/0/0ad/0ad-dbg_0.0.17-1_amd64.deb
    # Construct the destination URL
    target_list = target.split('/')
    if target_list[2]=="pool":
        cleaned = '/'.join([target_list[0]] + target_list[2:])
    elif target_list[2]=="dists":
        cleaned = '/'.join([target_list[0]] + ["ts"] + target_list[1:])
    else:
        cleaned = 'NA'

    destination = f'http://packages.trafficmanager.net/debian-snapshot/{cleaned}'

    return redirect(destination, code=302)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=80)