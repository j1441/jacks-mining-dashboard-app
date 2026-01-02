# Umbrel App Development Skill

This skill provides comprehensive guidance for developing applications for Umbrel OS, based on real-world experience from building the Mining Dashboard app.

## What This Skill Does

The `umbrel-app` skill helps you:
- Create new Umbrel apps from scratch
- Configure app manifests (umbrel-app.yml)
- Set up Docker Compose files properly
- Debug common Umbrel app issues
- Build multi-architecture Docker images
- Test apps locally
- Submit apps to the Umbrel App Store

## How to Use This Skill

### Automatic Activation

This skill is automatically activated when you ask Claude questions about Umbrel app development. Claude will detect when you need help with Umbrel-related tasks and use this skill to provide expert guidance.

**Example questions that trigger this skill:**
- "Help me create a new Umbrel app"
- "What should go in my umbrel-app.yml?"
- "My Umbrel app won't start, can you help debug?"
- "How do I build a multi-architecture Docker image for Umbrel?"
- "Review my docker-compose.yml for Umbrel"
- "How do I add Bitcoin dependencies to my Umbrel app?"

### Files in This Skill

1. **[SKILL.md](SKILL.md)** - Main skill file with quick reference, common tasks, and troubleshooting
2. **[MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md)** - Complete reference for all `umbrel-app.yml` fields
3. **[DOCKER_COMPOSE_GUIDE.md](DOCKER_COMPOSE_GUIDE.md)** - Comprehensive Docker Compose patterns and examples
4. **[EXAMPLES.md](EXAMPLES.md)** - Real-world examples from simple to complex apps

## Quick Start

### Creating Your First Umbrel App

1. **Ask Claude to help you start:**
   ```
   "Help me create a new Umbrel app for [your idea]"
   ```

2. **Claude will guide you through:**
   - Creating the app directory structure
   - Writing the umbrel-app.yml manifest
   - Setting up docker-compose.yml
   - Creating the Dockerfile
   - Building multi-architecture images
   - Testing locally

3. **Get help with specific issues:**
   ```
   "My app shows 'Starting...' but never loads"
   "How do I persist data in my Umbrel app?"
   "Review my manifest file for errors"
   ```

## Common Use Cases

### 1. Starting a New App
```
"I want to create an Umbrel app that does [X]. Help me set it up."
```

### 2. Debugging Issues
```
"My Umbrel app won't start. Here's my docker-compose.yml: [paste file]"
"I'm getting permission errors in my Umbrel app"
"App data is not persisting after restart"
```

### 3. Configuration Help
```
"What dependencies do I need to connect to Bitcoin Core?"
"How do I expose an additional port in my Umbrel app?"
"Show me how to add a database to my app"
```

### 4. Docker & Building
```
"How do I build a multi-architecture image for Umbrel?"
"Help me write a Dockerfile for my Node.js Umbrel app"
"How do I get the sha256 digest for docker-compose.yml?"
```

### 5. Submission
```
"I'm ready to submit my app to Umbrel. What do I need?"
"Review my app before I submit to the Umbrel App Store"
```

## Skill Features

### Expert Knowledge
- Real-world patterns from actual Umbrel apps
- Common pitfalls and how to avoid them
- Best practices for security and performance
- Tested solutions for common problems

### Comprehensive Coverage
- Single-container apps
- Multi-service apps with databases
- Bitcoin/Lightning integration
- Worker queue patterns
- Full-stack applications

### Debugging Support
- Permission issues
- Data persistence problems
- Networking issues
- Environment variable problems
- Port configuration issues

## Additional Resources

This skill references and complements:
- [UMBREL_APP_GUIDE.md](../../../UMBREL_APP_GUIDE.md) - Official Umbrel app framework guide in this repository
- [Official Umbrel Apps Repository](https://github.com/getumbrel/umbrel-apps)
- [Umbrel GitHub](https://github.com/getumbrel/umbrel)

## Skill Maintenance

This skill is part of the Mining Dashboard App repository and can be updated as you learn new patterns or encounter new issues. Feel free to:
- Add new examples to EXAMPLES.md
- Update troubleshooting steps in SKILL.md
- Document new patterns in DOCKER_COMPOSE_GUIDE.md
- Expand field descriptions in MANIFEST_REFERENCE.md

## For Your Team

Since this skill is in the `.claude/skills/` directory of your repository:
- It's automatically available to anyone using Claude Code on this project
- Team members can benefit from the accumulated knowledge
- Updates to the skill files are version-controlled with Git
- You can share this across projects by copying the directory

## Troubleshooting the Skill

If the skill isn't activating:

1. **Verify the skill is loaded:**
   Ask Claude: "What skills are available?"
   Look for "umbrel-app" in the response.

2. **Restart Claude Code:**
   Skills are loaded at startup. Exit and restart Claude Code.

3. **Check file structure:**
   ```
   .claude/
   └── skills/
       └── umbrel-app/
           ├── SKILL.md
           ├── MANIFEST_REFERENCE.md
           ├── DOCKER_COMPOSE_GUIDE.md
           ├── EXAMPLES.md
           └── README.md
   ```

4. **Verify SKILL.md frontmatter:**
   The file should start with:
   ```yaml
   ---
   name: umbrel-app
   description: Helps build, configure, debug...
   ---
   ```

## Examples of Skill Usage

### Example 1: Creating a New App
**You:** "Help me create an Umbrel app for monitoring my home solar panels"

**Claude (using this skill):**
- Asks about your app's requirements
- Generates umbrel-app.yml with proper structure
- Creates docker-compose.yml with best practices
- Provides Dockerfile template
- Explains how to build and test

### Example 2: Debugging
**You:** "My app won't start. Here's my docker-compose.yml: [paste]"

**Claude (using this skill):**
- Reviews configuration against best practices
- Identifies issues (e.g., missing _1 suffix in APP_HOST)
- Explains what's wrong and why
- Provides corrected configuration
- Suggests testing steps

### Example 3: Adding Features
**You:** "How do I add a PostgreSQL database to my Umbrel app?"

**Claude (using this skill):**
- Shows multi-service docker-compose.yml pattern
- Explains volume configuration for persistence
- Provides environment variable setup
- Shows how to connect from your app
- Includes security best practices

## Contributing

Found something that should be added to this skill? Update the relevant markdown file:
- General guidance → SKILL.md
- Manifest fields → MANIFEST_REFERENCE.md
- Docker patterns → DOCKER_COMPOSE_GUIDE.md
- New examples → EXAMPLES.md

## License

This skill is part of the Mining Dashboard App project and follows the same license.

---

**Ready to build Umbrel apps?** Just ask Claude for help with your Umbrel app development questions!
