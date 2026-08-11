.PHONY: setup build test lint check demo dev docker

setup:
	npm ci

build:
	npm run build

test:
	npm test

lint:
	npm run lint

check:
	npm run check
	npm run smoke

demo:
	npm run demo

dev:
	npm run dev -- proxy

docker:
	docker compose up --build
