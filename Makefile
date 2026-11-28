.PHONY: help init install install-prod test test-cov test-unit test-integration lint format build clean publish publish-test generate deps update sync

# Use bash as shell
SHELL := /bin/bash

# Project name (from top-level directory name)
PROJECT_NAME ?= $(shell basename $(CURDIR))

# Version for code generation (can be overridden)
VERSION ?= 0.55.14
READ_ONLY ?= false

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

docker:
	docker buildx build --platform linux/amd64 -t tmunzer/mist_switch_converter:latest .
# docker buildx build --platform linux/amd64,linux/arm64 -t tmunzer/mistmcp:latest .
