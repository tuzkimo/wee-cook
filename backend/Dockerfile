# backend/Dockerfile
FROM golang:1.25-alpine AS builder
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o server ./cmd/server

FROM gcr.io/distroless/static
COPY --from=builder /app/server /server
ENV FILES_DIR=/data/files
EXPOSE 8080
ENTRYPOINT ["/server"]
