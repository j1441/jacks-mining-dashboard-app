#!/bin/bash
set -e

# Configuration
DOCKER_USERNAME="j73642"
IMAGE_NAME="mining-dashboard-app"
VERSION="v1.0.11"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Building Jack's Mining Dashboard${NC}"
echo -e "${BLUE}Version: ${VERSION}${NC}"
echo -e "${BLUE}========================================${NC}"

# Build for multiple architectures (amd64 and arm64 for Umbrel compatibility)
echo -e "\n${GREEN}Step 1: Building Docker image...${NC}"
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION} \
  -t ${DOCKER_USERNAME}/${IMAGE_NAME}:latest \
  --push \
  .

echo -e "\n${GREEN}Step 2: Getting image digest...${NC}"
DIGEST=$(docker buildx imagetools inspect ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION} --format '{{json .Manifest}}' | jq -r '.digest')

echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Build complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Image: ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}"
echo -e "Digest: ${DIGEST}"
echo -e "\n${BLUE}Update your community store with:${NC}"
echo -e "image: ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}@${DIGEST}"
echo -e "${BLUE}========================================${NC}"
