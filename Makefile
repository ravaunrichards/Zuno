.PHONY: install dev test verify gifts assets db build package clean

install:
	pnpm install

dev:
	node scripts/dev.js

test:
	node scripts/run-tests.js

verify:
	node scripts/verify.js

gifts:
	python3 scripts/generate_gifts.py

assets:
	node scripts/validate-assets.js

db:
	node scripts/validate-db.js

build:
	node scripts/build.js

package:
	node scripts/package.js

clean:
	rm -rf node_modules dist build .turbo coverage
