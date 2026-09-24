# re-region-web

A web-based tool to search, look up, and map title IDs and game releases across different regions (US, EU, JP, AS, KR).

## Features

- **Multi-region Search**: Look up game titles and find their corresponding Title IDs and region variants.
- **Offline Database**: Powered by a local SQLite database (`titles.db`) containing titles and metadata.
- **Synchronization Script**: Includes `sync_titles.py` to update and synchronize the title database with the latest entries.
- **Lightweight Web Interface**: Built with vanilla HTML5, CSS3, and JavaScript with SVG regional badges.
- **GitHub Pages Ready**: Includes `.nojekyll` configuration for direct deployment.

## Project Structure

```text
re-region-web/
├── index.html        # Main web interface
├── app.js            # Client-side search and application logic
├── style.css         # Styling and layout
├── titles.db         # SQLite database storing title IDs and region metadata
├── sync_titles.py    # Python script to update/synchronize titles.db
├── .nojekyll         # Disables Jekyll processing for GitHub Pages hosting
└── SVGs/             # Regional flag icons
    ├── AS.svg        # Asia
    ├── EU.svg        # Europe
    ├── IP.svg        # International / Region-free
    ├── JP.svg        # Japan
    ├── KR.svg        # Korea
    └── US.svg        # United States

```

## Getting Started

### Running Locally

1. Clone or extract the repository:
```bash
git clone https://github.com/m2k7m/re-region-web.git
cd re-region-web

```


2. Start a local HTTP server:
```bash
# Using Python 3
python -m http.server 8000

```


3. Open your browser and navigate to:
```text
http://localhost:8000

```



### Updating the Database

To sync or update `titles.db` with the latest title lists, run the Python sync script:

```bash
python sync_titles.py

```

## Deployment

This repository is pre-configured for **GitHub Pages**:

1. Push the repository to GitHub.
2. In your repository settings, navigate to **Pages**.
3. Under **Build and deployment**, select **Deploy from a branch** and choose `main` (or `gh-pages`) root folder (`/`).
4. Save, and your app will be live.

## License

This project is open-source and available under the [MIT License](https://github.com/m2k7m/re-region-web/blob/main/License).