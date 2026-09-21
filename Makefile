# Global Dialogues raw-data explorer
DATA   ?= ../global-dialogues/Data
ROUNDS ?= GD1 GD2 GD3 GD4 GD5 GD6 GD6UK GD7 GD8 GD9
PY     := .venv/bin/python

.PHONY: explorer-data explorer-dev explorer-build

.venv:
	uv venv --python 3.11 .venv
	uv pip install --python $(PY) -r requirements.txt

explorer/node_modules: explorer/package.json
	cd explorer && npm install

explorer-data: .venv  ## CSV -> parquet + build_report.json (fails if counts disagree with Data/README.md)
	$(PY) tools/explorer/build_parquet.py --data $(DATA) --rounds $(ROUNDS)

explorer-dev: explorer/node_modules  ## dev server
	cd explorer && npm run dev

explorer-build: explorer/node_modules  ## static site in explorer/dist (includes data/)
	cd explorer && npm run build
