0. Install the server <https://docs.nats.io/running-a-nats-service/introduction/installation>
1. Copy config from <https://github.com/ConnectEverything/nats-whiteboard/blob/main/nats.conf>
2. `nats-server -c nats.conf --trace -DVV`
3. Start a web server serving local files from this branch:

```
# cd jetstream/examples
# python3 -m http.server 
Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) 
```

4. Open <http://0.0.0.0:8000/> in the browser, and see idle heartbeat messages in the console.
