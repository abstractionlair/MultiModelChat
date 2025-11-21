#!/bin/bash

BASE_URL="http://localhost:3000"

echo "=== Testing File APIs ==="

# Get default project ID using node
PROJECT_ID=$(node -e "try { const { getDefaultProjectId } = require('./server/db/index'); console.log(getDefaultProjectId()); } catch(e) { console.error(e); process.exit(1); }")

if [ $? -ne 0 ] || [ -z "$PROJECT_ID" ]; then
  echo "Error: Could not determine Project ID."
  exit 1
fi

echo "Using project: $PROJECT_ID"

# Create temp directory
mkdir -p temp_test

# Test 1: Upload a small file
echo -e "\n1. Uploading small file..."
cat > temp_test/upload_small.json <<EOF
{
    "path": "test/hello.md",
    "content": "# Hello World\n\nThis is a test file.",
    "metadata": {"tags": ["test", "docs"]}
}
EOF

FILE1=$(curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d @temp_test/upload_small.json)
echo "$FILE1" | jq .

FILE1_ID=$(echo "$FILE1" | jq -r '.id')

if [ "$FILE1_ID" == "null" ] || [ "$FILE1_ID" == "" ]; then
    echo "Failed to upload file."
    exit 1
fi

# Test 2: List files
echo -e "\n2. Listing files..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files" | jq .

# Test 3: Get file content
echo -e "\n3. Reading file..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

# Test 4: Upload with same path (update)
echo -e "\n4. Updating file..."
cat > temp_test/upload_update.json <<EOF
{
    "path": "test/hello.md",
    "content": "# Hello World (Updated)\n\nThis file was updated.",
    "metadata": {"tags": ["test", "docs", "updated"]}
}
EOF
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d @temp_test/upload_update.json | jq .

# Test 5: Upload a large file
echo -e "\n5. Uploading large file..."
# Generate large content
node -e "
  const fs = require('fs');
  const content = 'Line '.repeat(300000); // ~1.5MB, should trigger disk storage (threshold is 1MB)
  const data = {
    path: 'data/large.txt',
    content: content
  };
  fs.writeFileSync('temp_test/upload_large.json', JSON.stringify(data));
"

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d @temp_test/upload_large.json | jq 'del(.content)'

# Test 6: Delete file
echo -e "\n6. Deleting file..."
curl -s -X DELETE "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

# Test 7: Verify deletion
echo -e "\n7. Verify deletion (should 404)..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

echo -e "\n=== Tests complete ==="
# Cleanup
rm -rf temp_test
