FROM nginx:1.27-alpine

COPY website /usr/share/nginx/html

# Only the assets the site actually references — avoids publishing
# questions.json (the app's question bank), backups and unused icons.
COPY assets/favicon.png assets/icon.png assets/adaptive-icon.png \
  /usr/share/nginx/html/assets/
COPY store-assets/caa-quiz1.jpeg store-assets/caa-quiz2.jpeg \
  store-assets/caa-quiz3.jpeg store-assets/caa-quiz4.jpeg \
  store-assets/caa-quiz5.jpeg store-assets/caa-quiz6.jpeg \
  /usr/share/nginx/html/store-assets/

EXPOSE 80
