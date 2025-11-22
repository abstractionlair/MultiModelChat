#!/bin/bash

# Test search API

BASE_URL="http://localhost:3000"

echo "=== Testing Search API ==="

# Get default project ID from the database
PROJECT_ID=$(sqlite3 data.db "SELECT id FROM projects LIMIT 1;" 2>/dev/null)

# If that fails, create a test conversation to get project ID
if [ -z "$PROJECT_ID" ]; then
  echo "No projects found in database, creating a test conversation..."
  curl -s -X POST "$BASE_URL/api/turn" \
    -H "Content-Type: application/json" \
    -d '{"userMessage":"test","targetModels":[{"provider":"mock","modelId":"mock-echo"}]}' > /dev/null

  PROJECT_ID=$(curl -s "$BASE_URL/api/conversations" | jq -r '.conversations[0].project_id')
fi

echo "Using project: $PROJECT_ID"

# First, upload some test files
echo -e "\n1. Uploading test files..."

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/authentication.md",
    "content": "# Authentication System\n\nOur authentication flow uses JWT tokens for secure access. The login endpoint validates credentials and returns a token.\n\n## Implementation\n\nThe auth middleware checks the token on each request."
  }' > /dev/null

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "src/auth.js",
    "content": "// Authentication module\nfunction authenticate(username, password) {\n  // Validate credentials\n  const user = db.findUser(username);\n  if (!user) return null;\n  \n  // Generate JWT token\n  const token = jwt.sign({ userId: user.id }, SECRET);\n  return token;\n}"
  }' > /dev/null

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/database.md",
    "content": "# Database Schema\n\nWe use SQLite for data persistence. The main tables are users, projects, and conversations."
  }' > /dev/null

echo "✓ Test files uploaded"

# Wait for indexing
sleep 2

# Test 2: Basic search
echo -e "\n2. Testing basic search (query: 'authentication')..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "authentication"
  }' | jq '{ total_results, execution_time_ms, results: [.results[] | { path, highlighted }] }'

# Test 3: Search with file type filter
echo -e "\n3. Testing search with file type filter (query: 'authentication', filter: *.md)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "authentication",
    "filters": {
      "file_types": [".md"]
    }
  }' | jq '{ total_results, results: [.results[] | { path }] }'

# Test 4: Search with path filter
echo -e "\n4. Testing search with path filter (query: 'database', filter: docs/*)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "database",
    "filters": {
      "paths": ["docs/*"]
    }
  }' | jq '{ total_results, results: [.results[] | { path, location }] }'

# Test 5: Search with pagination
echo -e "\n5. Testing pagination (query: 'the', limit: 2, offset: 0)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "the",
    "limit": 2,
    "offset": 0
  }' | jq '{ total_results, limit, offset, returned: (.results | length) }'

# Test 6: Search with special characters (injection test)
echo -e "\n6. Testing query escaping (query with quotes)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "\"JWT tokens\""
  }' | jq '{ total_results, execution_time_ms }'

# Test 7: Empty query (should fail)
echo -e "\n7. Testing empty query (should return 400)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": ""
  }' | jq .

# Test 8: Invalid project (should fail)
echo -e "\n8. Testing invalid project (should return 404)..."
curl -s -X POST "$BASE_URL/api/projects/proj_invalid/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "test"
  }' | jq .

echo -e "\n=== Tests complete ==="
