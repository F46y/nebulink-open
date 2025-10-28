# Use an official Go image with version 1.25
FROM golang:1.25

# Set the working directory inside the container
WORKDIR /app

# Copy go.mod and go.sum first to leverage Docker cache
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy the rest of the application code
COPY . .

# Build the Go app
RUN go build -o main .

EXPOSE 3737

# Command to run the app
CMD ["./main"]