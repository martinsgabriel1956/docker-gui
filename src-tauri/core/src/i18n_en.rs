// Tabela do EN do docker_gui.py: as mensagens do backend em inglês. O teste i18n_matches_python confere que as
// duas continuam iguais (mudou lá, muda aqui).
pub const EN: &[(&str, &str)] = &[
    (
        "{cli} {cmd} não respondeu em {timeout}s. O daemon está travado?",
        "{cli} {cmd} did not respond in {timeout}s. Is the daemon stuck?",
    ),
    ("corpo inválido: esperado um objeto JSON", "invalid body: expected a JSON object"),
    ("campo não suportado: {fields}", "unsupported field: {fields}"),
    ("{key}: tipo inválido", "{key}: invalid type"),
    ("{key}: no máximo {n} itens", "{key}: at most {n} items"),
    ("imagem inválida: use repo[:tag] ou repo@sha256:…", "invalid image: use repo[:tag] or repo@sha256:…"),
    (
        "nome inválido: 2 a 128 caracteres entre letras, números, _ . e -, começando por letra ou número",
        "invalid name: 2 to 128 characters among letters, digits, _ . and -, starting with a letter or digit",
    ),
    ("restart inválido: use {options}", "invalid restart: use {options}"),
    (
        "porta inválida: {port} (use portaDoHost:portaDoContainer[/tcp|udp], de 1 a 65535)",
        "invalid port: {port} (use hostPort:containerPort[/tcp|udp], from 1 to 65535)",
    ),
    ("porta do host repetida: {port}", "host port repeated: {port}"),
    (
        "variável inválida: {var} (use CHAVE=valor; a chave com letras, números e _)",
        "invalid variable: {var} (use KEY=value; the key with letters, digits and _)",
    ),
    ("{key}: valor com NUL ou maior que {n} caracteres", "{key}: value with NUL or longer than {n} characters"),
    ("variável repetida: {key}", "variable repeated: {key}"),
    (
        "volume inválido: use nome:/caminho/no/container (só volume nomeado, nunca pasta do host)",
        "invalid volume: use name:/path/in/container (named volumes only, never a host folder)",
    ),
    ("token ausente ou inválido", "missing or invalid token"),
    ("origem não permitida", "origin not allowed"),
    ("esperava um WebSocket", "expected a WebSocket"),
    ("tail inválido", "invalid tail"),
    ("since inválido", "invalid since"),
    ("não consegui ler quando o container subiu", "could not read when the container started"),
    ("formato inesperado na saída do {cmd}", "unexpected format in the output of {cmd}"),
    ("streams de eventos demais abertos", "too many event streams open"),
    ("{name} é uma rede padrão e não pode ser removida", "{name} is a default network and cannot be removed"),
    (
        "Conectado, mas sem TTY: a imagem não tem o script, que o terminal usa no Windows. Comandos simples funcionam; vim, less, Tab e Ctrl+C não. Feche pelo ×.",
        "Connected, but without a TTY: the image has no script, which the terminal uses on Windows. Simple commands work; vim, less, Tab and Ctrl+C don't. Close with ×.",
    ),
    ("corpo inválido: esperado JSON de até {n} KiB", "invalid body: expected JSON of up to {n} KiB"),
    ("corpo inválido: esperado {project, dir, service}", "invalid body: expected {project, dir, service}"),
    ("corpo inválido: esperado {project, dir}", "invalid body: expected {project, dir}"),
    ("query inválida: esperado ?project=...&dir=...", "invalid query: expected ?project=...&dir=..."),
    ("projeto compose não encontrado", "compose project not found"),
    ("serviço não encontrado no projeto", "service not found in the project"),
    ("Porta {port} ocupada. Escolha outra com --port.", "Port {port} is in use. Pick another with --port."),
    (
        "Portas {first}-{last} ocupadas. Escolha uma com --port.",
        "Ports {first}-{last} are in use. Pick one with --port.",
    ),
    (
        "Stivo: containers Docker e Podman no navegador. Só stdlib + docker CLI.",
        "Stivo: Docker and Podman containers in the browser. Stdlib + docker CLI only.",
    ),
    ("porta local (padrão: {port}, ou a próxima livre)", "local port (default: {port}, or the next free one)"),
    (
        "CLI de containers: docker ou podman (padrão: $DOCKER_GUI_CLI ou docker)",
        "container CLI: docker or podman (default: $DOCKER_GUI_CLI or docker)",
    ),
    (
        "contexto do docker (docker --context); sem ele vale o DOCKER_CONTEXT ou o atual",
        "docker context (docker --context); without it, DOCKER_CONTEXT or the current one",
    ),
    (
        "língua da página e das mensagens: pt ou en (padrão: $DOCKER_GUI_LANG ou o locale do sistema)",
        "language of the page and messages: pt or en (default: $DOCKER_GUI_LANG or the system locale)",
    ),
    ("Stivo em {url}  (Ctrl+C para sair)", "Stivo at {url}  (Ctrl+C to quit)"),
    (
        "não abre o navegador; o link sai só no terminal",
        "don't open the browser; the link is only printed in the terminal",
    ),
];
