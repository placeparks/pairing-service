FROM node:20-slim

# Install Railway CLI
RUN npm install -g @railway/cli

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application
COPY server.js ./

# Expose port
EXPOSE 3001

# Start service
CMD ["node", "server.js"]
