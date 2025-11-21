#!/bin/bash

# Test file upload and retrieval APIs

BASE_URL="http://localhost:3000"

echo "=== Testing File APIs ==="

# Get default project ID directly from DB
PROJECT_ID=$(node -e "
try {
  const { db } = require('./server/db/index');
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('default_project_id');
  console.log(row ? row.value : '');
} catch (e) {
  console.error(e);
  process.exit(1);
}
")

if [ -z "$PROJECT_ID" ]; then
  echo "Could not find project ID in DB. Make sure migrations have run."
  exit 1
fi

echo "Using project: $PROJECT_ID"

# Test 1: Upload a small file
echo -e "\n1. Uploading small file..."
FILE1=$(curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "test/hello.md",
    "content": "# Hello World\n\nThis is a test file.",
    "metadata": {"tags": ["test", "docs"]}
  }')
echo "$FILE1" | jq .

FILE1_ID=$(echo "$FILE1" | jq -r '.id')

if [ "$FILE1_ID" == "null" ] || [ -z "$FILE1_ID" ]; then
  echo "Upload failed"
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
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "test/hello.md",
    "content": "# Hello World (Updated)\n\nThis file was updated.",
    "metadata": {"tags": ["test", "docs", "updated"]}
  }' | jq .

# Test 5: Upload a large file (simulate by sending > 1MB if possible, but curl might choke on command line argument length)
echo -e "\n5. Uploading medium file (to check logic)..."
MEDIUM_CONTENT=$(python3 -c "print('A' * 10000)")
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"data/medium.txt\",
    \"content\": \"$MEDIUM_CONTENT\"
  }" | jq .

# Test 6: Delete file
echo -e "\n6. Deleting file..."
curl -s -X DELETE "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

# Test 7: Verify deletion
echo -e "\n7. Verify deletion (should 404)..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

echo -e "\n=== Tests complete ==="
