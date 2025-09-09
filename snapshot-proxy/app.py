from flask import Flask, redirect, request
import re

app = Flask(__name__)

# Define a simple redirect rule
@app.route('/debian-snapshot/<path:target>')
def redirect_to_target(target):
    # Construct the destination URL
    cleaned = re.sub(r'/ts/[^/]+', '', target)
    destination = f'http://packages.trafficmanager.net/debian-snapshot/{cleaned}'

    return redirect(destination, code=302)  # Use 301 for permanent redirect

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=80)