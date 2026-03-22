# 1. Usar imagen oficial de Node.js
FROM node:24-slim

# 2. Directorio de trabajo en el contenedor
WORKDIR /usr/src/app

# 3. Instalar dependencias primero para aprovechar el cache
COPY package*.json ./
RUN npm install --production

# 4. Copiar el resto del código del servidor y la App compilada
COPY . .

# 5. Puerto dinámico para Cloud Run
ENV PORT=8080
EXPOSE 8080

# 6. Encender el motor de trading
CMD [ "node", "server.js" ]
