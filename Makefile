.PHONY: build test bundle lint

build: test

lint:
	deno lint

test: clean
	deno task test

cover:
	deno task cover

clean:
	deno task clean

bundle:
	deno bundle --log-level info --unstable src/mod.ts ./nats.js
	deno bundle --log-level info --unstable jetstream/mod.ts ./jetstream.js
	deno bundle --log-level info --unstable kv/mod.ts ./kv.js
	deno bundle --log-level info --unstable obj/mod.ts ./os.js
	deno bundle --log-level info --unstable service/mod.ts ./svc.js


fmt:
	deno fmt