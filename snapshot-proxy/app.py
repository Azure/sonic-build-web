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
    # Construct the destination URL
    cleaned = re.sub(r'^([^/]+/)[^/]+/', r'\1', target)
    destination = f'http://packages.trafficmanager.net/snapshot/{cleaned}'

    return redirect(destination, code=302)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=80)