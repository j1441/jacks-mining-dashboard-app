#!/bin/bash
set -e

# Configuration
DOCKER_USERNAME="j73642"
IMAGE_NAME="mining-dashboard-app"
VERSION="v1.0.11"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Building Jack's Mining Dashboard${NC}"
echo -e "${BLUE}Version: ${VERSION}${NC}"
echo -e "${BLUE}========================================${NC}"

# Build for current architecture
echo -e "\n${GREEN}Step 1: Building Docker image...${NC}"
docker build -t ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION} .

echo -e "\n${GREEN}Step 2: Tagging as latest...${NC}"
docker tag ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION} ${DOCKER_USERNAME}/${IMAGE_NAME}:latest

echo -e "\n${GREEN}Step 3: Pushing to Docker Hub...${NC}"
docker push ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}
docker push ${DOCKER_USERNAME}/${IMAGE_NAME}:latest

echo -e "\n${GREEN}Step 4: Getting image digest...${NC}"
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION} | cut -d'@' -f2)

echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Build complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Image: ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}"
if [ ! -z "$DIGEST" ]; then
    echo -e "Digest: ${DIGEST}"
    echo -e "\n${BLUE}Update your community store docker-compose.yml with:${NC}"
    echo -e "image: ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}@${DIGEST}"
else
    echo -e "\n${BLUE}Update your community store docker-compose.yml with:${NC}"
    echo -e "image: ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}"
fi
echo -e "\n${BLUE}Update your umbrel-app.yml version to: 1.0.11${NC}"
echo -e "${BLUE}========================================${NC}"
