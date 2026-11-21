// Instrukcja instalacji OŁCyŚ jako usługi systemowej. Skrypt NICZEGO nie instaluje — wypisuje plik usługi
// i polecenia do wykonania przez administratora.
//
//   node scripts/install-service.ts [--system linux|windows] [--user <konto>] [--output <plik>] [--config <plik>]
//
// --output zapisuje plik jednostki systemd we wskazanym miejscu (np. ./olcys.service) — kopiowanie do /etc/systemd
// pozostaje decyzją administratora.

import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, bold, dim, flagString, green, parseArgs } from './lib/env.ts';

const args = parseArgs(process.argv.slice(2));
const system = flagString(args, 'system') ?? (process.platform === 'win32' ? 'windows' : 'linux');
const envFile = resolve(ROOT, flagString(args, 'config') ?? '.env');
const node = process.execPath;
const runner = join(ROOT, 'scripts', 'run.ts');

if (system === 'linux') {
  const user = flagString(args, 'user') ?? (userInfo().username === 'root' ? 'olcys' : userInfo().username);
  const unit = `# OŁCyŚ — jednostka systemd. Instalacja (jako root):
#   cp olcys.service /etc/systemd/system/olcys.service
#   systemctl daemon-reload && systemctl enable --now olcys
# Dziennik: journalctl -u olcys -f      Zatrzymanie: systemctl stop olcys (łagodne — zapis bazy)
[Unit]
Description=OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów (API + interfejs)
After=network-online.target
Wants=network-online.target
# Przy zewnętrznym PostgreSQL na tej samej maszynie odkomentuj:
# After=postgresql.service

[Service]
Type=simple
User=${user}
WorkingDirectory=${ROOT}
ExecStart=${node} ${runner} start --config ${envFile}
Environment=NODE_ENV=production
Environment=NO_COLOR=1
# SIGTERM tylko do procesu głównego: skrypt sam zamyka API łagodnie (migawka bazy), potem piaskownicę.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=150
Restart=on-failure
RestartSec=5
# Utwardzenie: zapis tylko do katalogu danych (dopisz katalogi z OLCYS_DATA_DIR / OLCYS_BACKUP_DIR, jeśli są poza repozytorium).
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${ROOT}

[Install]
WantedBy=multi-user.target
`;
  const output = flagString(args, 'output');
  if (output) {
    writeFileSync(resolve(output), unit, 'utf8');
    console.log(green(`Zapisano: ${resolve(output)}`));
    console.log(dim('Skopiuj plik do /etc/systemd/system/ i wykonaj polecenia z nagłówka pliku.'));
  } else {
    console.log(bold('Jednostka systemd (zapisz jako /etc/systemd/system/olcys.service):\n'));
    console.log(unit);
  }
  console.log(`${bold('Uwagi')}
  • Konto ${user} musi mieć prawo zapisu do katalogu danych (OLCYS_DATA_DIR) i odczytu pliku ${envFile}.
    Utworzenie konta technicznego: useradd --system --home ${ROOT} --shell /usr/sbin/nologin ${user}
  • Plik .env zawiera sekrety: chown ${user}: ${envFile} && chmod 600 ${envFile}
  • Kopia zapasowa co noc (crontab konta ${user}):
      15 2 * * * cd ${ROOT} && ${node} scripts/backup.ts --config ${envFile} --wait-fresh >> /var/log/olcys-kopia.log 2>&1
`);
} else if (system === 'windows') {
  console.log(`${bold('Windows — usługa przez NSSM (https://nssm.cc), zalecane')}
Polecenia dla PowerShell uruchomionego jako administrator:

  nssm install OLCYS "${node}" "${runner}" start --config "${envFile}"
  nssm set OLCYS AppDirectory "${ROOT}"
  nssm set OLCYS AppEnvironmentExtra NODE_ENV=production NO_COLOR=1
  nssm set OLCYS AppStdout "${join(ROOT, 'olcys-usluga.log')}"
  nssm set OLCYS AppStderr "${join(ROOT, 'olcys-usluga.log')}"
  # Zatrzymanie: najpierw Ctrl+C (łagodne zamknięcie i zapis bazy), czas do 150 s; bez zabijania okien i wątków.
  nssm set OLCYS AppStopMethodSkip 6
  nssm set OLCYS AppStopMethodConsole 150000
  nssm set OLCYS Start SERVICE_AUTO_START
  nssm start OLCYS

  Stan: nssm status OLCYS      Zatrzymanie: nssm stop OLCYS      Usunięcie: nssm remove OLCYS confirm

${bold('Bez NSSM — Harmonogram zadań (uruchomienie przy starcie systemu)')}

  $akcja = New-ScheduledTaskAction -Execute "${node}" -Argument '"${runner}" start --config "${envFile}"' -WorkingDirectory "${ROOT}"
  $wyzwalacz = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask -TaskName OLCYS -Action $akcja -Trigger $wyzwalacz -User "NT AUTHORITY\\SYSTEM" -RunLevel Highest

  Zatrzymanie zawsze łagodnie (nie „Zakończ zadanie”):
    Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<API_PORT>/api/admin/shutdown

${bold('Uwagi')}
  • sc.exe nie uruchomi skryptu Node bezpośrednio (wymaga programu usługi) — stąd NSSM albo WinSW.
  • Konto usługi musi mieć prawo zapisu do katalogu danych (OLCYS_DATA_DIR).
  • Kopia zapasowa co noc: zadanie w Harmonogramie z poleceniem
      "${node}" "${join(ROOT, 'scripts', 'backup.ts')}" --config "${envFile}" --wait-fresh
`);
} else {
  console.error('--system: dozwolone linux albo windows.');
  process.exit(2);
}
