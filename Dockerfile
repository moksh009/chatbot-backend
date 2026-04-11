# Use lightweight Alpine image for production efficiency
FROM node:18-alpine

# Set the working directory
WORKDIR /usr/src/app

# Only copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 5001

# Command to start the server
# Note: Ensure REDIS_URL and MONGODB_URI are provided via environment
CMD ["node", "index.js"]
