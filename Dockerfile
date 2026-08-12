FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the application
COPY . .

# Build the TypeScript code
RUN npm run build

# Ensure profile directory exists in case it's not mounted
RUN mkdir -p .data/chatgpt-profile

# Expose port and configure environment
EXPOSE 11436
ENV HOST=0.0.0.0
ENV PORT=11436
ENV HEADLESS=true

# Start the built server
CMD ["npm", "start"]
