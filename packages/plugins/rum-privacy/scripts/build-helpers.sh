PROJECT_ROOT="$(git rev-parse --show-toplevel)"
cd "$PROJECT_ROOT/packages/plugins/rum-privacy"

# Build dictionary-helpers
yarn build:privacy-helpers
# check if the built file exists
if [ ! -f ./src/generated/privacy-helpers.js ]; then
  echo "Error: privacy-helpers.js not found after build."
  exit 1
fi
# Rename the built file to privacy-helpers.js-txt
mv ./src/generated/privacy-helpers ./src/generated/privacy-helpers.js-txt
