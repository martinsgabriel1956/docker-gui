# Pacotes do Stivo desktop

Os instaladores saem do `release.yml` em cada tag `v*` (`.deb`, `.rpm`, `.msi`, `.exe` e o `SHA256SUMS`). Os canais
abaixo só apontam para eles; publicar é com a sua conta em cada um.

## AUR (`stivo-bin`)

`aur/PKGBUILD` desempacota o `.deb` da release. Para cada versão nova, num Arch (ou num container `archlinux`):

```bash
cd packaging/aur
sed -i "s/^pkgver=.*/pkgver=0.2.0/; s/^pkgrel=.*/pkgrel=1/" PKGBUILD
updpkgsums                              # troca os SKIP pelos sha256 de verdade
makepkg --printsrcinfo > .SRCINFO
namcap PKGBUILD
git clone ssh://aur@aur.archlinux.org/stivo-bin.git /tmp/stivo-bin   # a primeira vez cria o pacote no AUR
cp PKGBUILD .SRCINFO /tmp/stivo-bin && cd /tmp/stivo-bin && git commit -am "Stivo 0.2.0" && git push
```

## winget (`MartinsGabriel.Stivo`)

`winget/manifests/m/MartinsGabriel/Stivo/<versão>/` tem os três arquivos do manifesto (version, installer e o
defaultLocale em pt-BR). Para cada versão: copie a pasta com a versão nova, troque a `PackageVersion`, a
`InstallerUrl` e a `InstallerSha256` (a linha do `.msi` no `SHA256SUMS` da release), confira com
`winget validate --manifest <pasta>` no Windows e abra um PR no
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) com a pasta no mesmo caminho
(`manifests/m/MartinsGabriel/Stivo/<versão>/`). O `wingetcreate update MartinsGabriel.Stivo --version <v> --urls <url do .msi>`
faz as trocas e o PR de uma vez.
