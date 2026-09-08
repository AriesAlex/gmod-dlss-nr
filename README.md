# GMod · DLSS Ray Reconstruction + Neural Rendering

Переносимый комплект текущего стека Garry's Mod RTX: готовые DLL, закреплённые архивы, исходники, локальные патчи, установщик и проверка. Основной профиль `native` выполняет **Ray Reconstruction → Neural Rendering → тонмаппинг** внутри Remix. ReShade в этом профиле не используется.

## Один промпт для следующего развёртывания

> Прочитай AGENTS.md и README.md в этом проекте. Разверни основной профиль native на чистый Garry's Mod x86-64 в отдельную папку Projects/gmod-rtx-neural-rendering. Найди установленные Steam-копии Garry's Mod и Half-Life 2 RTX, проверь зависимости и хеши, выполни план установки, затем setup --apply и verify. Не меняй Steam-оригинал и не останавливай запущенную игру. Если целевая игра работает, подготовь всё остальное и дождись её закрытия. Сохрани мои настройки при обновлении. После моего запуска и загрузки карты проверь реальную обработку RR+NR по свежему логу; до этого не называй runtime проверенным.

Нужны установленный **Garry's Mod, ветка `x86-64`**, и **Half-Life 2 RTX** с ресурсами. Игры и их Steam-файлы в комплект не входят. Проверенная ревизия GMod — Steam build **25110718**; совместимость определяется хешами четырёх DLL в `config/engine-patches.json`. Установщик откажется патчить другую ревизию вместо применения старых смещений.

Для готового комплекта нужны Windows x64, Bun, .NET SDK 10 и право создавать файловые ссылки. Git LFS нужен при переносе через Git. RTX/NR проверяется на NVIDIA RTX 5070 Ti; текущий драйвер — 616.64. Это описание проверенной конфигурации, а не заявленный минимальный набор GPU и драйверов.

## Установка

Запускай из корня этого проекта. Пути ниже — пример стандартной Steam-библиотеки; `--target` должен быть отдельной пустой папкой либо уже управляемой этим установщиком установкой.

```powershell
bun install --frozen-lockfile
bun run verify:artifacts
bun run setup --source "C:\Program Files (x86)\Steam\steamapps\common\GarrysMod" --target "$env:USERPROFILE\Documents\Projects\gmod-rtx-neural-rendering" --hl2rtx "C:\Program Files (x86)\Steam\steamapps\common\Half-Life 2 RTX"
```

Последняя команда показывает план без записи в игру. После проверки путей:

```powershell
bun run setup --source "C:\Program Files (x86)\Steam\steamapps\common\GarrysMod" --target "$env:USERPROFILE\Documents\Projects\gmod-rtx-neural-rendering" --hl2rtx "C:\Program Files (x86)\Steam\steamapps\common\Half-Life 2 RTX" --apply
bun run verify --target "$env:USERPROFILE\Documents\Projects\gmod-rtx-neural-rendering"
```

Запуск игры — через созданный `launch-gmod-rtx.cmd`. Разрешение не зашито в ярлык; можно передать обычные параметры Source. Локальная установка запускается с `-insecure`. Установщик не запускает и не завершает игру, не меняет Steam launch options и системную регистрацию Vulkan-слоёв.

Скопированы необходимые каталоги GMod, а крупные VPK, `platform`, `sourceengine` и ресурсы HL2 RTX связаны с установленными Steam-копиями. Эти оригинальные папки должны оставаться доступными. Личные аддоны, сохранения, бинды, кэши и QA-скрипты не переносятся. Генерация геометрии, шейдеров и PBR-кэшей выполняется игрой заново.

Повторный `setup --target <путь> --apply` берёт источники из `.gmod-dlss-nr.json`, обновляет управляемые файлы и сохраняет редактируемые конфиги. При смене профиля меняются принадлежащие профилю параметры RR/NR. Установщик отказывается работать с чужой непустой папкой, перенаправленной целью, несовместимыми DLL и работающей целевой игрой.

`bun run fetch` восстанавливает отсутствующие архивы с проверкой SHA256. Поскольку nightly assets могут меняться, скачанный файл с другим хешем отклоняется. Сохранённые копии `payload/archives` являются частью комплекта, а не одноразовым кэшем. Собранные нами DLL и закрытые NR/provider DLL следует переносить вместе с проектом; `fetch` их не восстанавливает.

## Настройки и проверка в игре

Основные настройки: **Alt+X → Developer Menu → Rendering → Post-Processing → Neural Rendering**. Ray Reconstruction включается в `Rendering → General`. Начальный профиль: DLSS Quality, RR, DLSS Frame Generation 2x, NR Intensity 2, Local Tone 1, Style 1. Параметры задают `config/base` и `config/profiles/native.conf`; Remix сохраняет пользовательские изменения в `user.conf` и `rtx.conf` установленной игры.

```powershell
bun run doctor --target "$env:USERPROFILE\Documents\Projects\gmod-rtx-neural-rendering"
```

`doctor` только читает `rtx-remix/logs/remix-dxvk.log`. Успешный NR подтверждается строками `NVIDIA DLSS-NR evaluated (count=1` и последующими счётчиками после успешного `EvaluateFeature`. Для RR требуется отдельная строка `NVIDIA DLSS-RR evaluated successfully` после успешного NVIDIA Evaluate; метка `RR guides selected` в строке NR подтверждает выбор входов от RR. Проверяй эти события в одном свежем запуске вместе с ошибками. Загрузка `nvngx_dlssnr.dll` или галочка в меню сами по себе не доказывают обработку кадров. Пока на экране `Compiling shaders`, RTX-проходы могут ещё не запускаться.

Для диагностики компиляции выводятся пары `Compiling Remix pipeline` / `Finished Remix pipeline` с именем, хешем и длительностью. Счётчик remaining включает ожидающие задания; последнее начало без завершения показывает место остановки очереди. В поставляемом исходнике исправлена публикация счётчика заданий до постановки в очередь и уведомления рабочих потоков.

`verify` проверяет поставляемые файлы обоих ZIP с учётом окончательных замен, payload, четыре engine patch и целостность смонтированных HL2 RTX ресурсов. Редактируемые настройки не обязаны совпадать с начальными. Проверка файлов не заменяет запуск карты и визуальную оценку.

Старый профиль `bridge` сохранён для воспроизведения предыдущего результата **DLSS Super Resolution + NR**:

```powershell
bun run setup --target "D:\Games\GMod-RTX" --profile bridge --apply
bun run setup --target "D:\Games\GMod-RTX" --profile native --apply
```

В `bridge` RR выключен, native NR выключен, ReShade загружает `dlss5-bridge` и `renodx-dlss5`; настройки находятся в Home → DLSS 5 Bridge. При возврате в `native` аддоны отключаются, запуск блокирует Vulkan-слой ReShade. Старый bridge не умеет получать подходящий кадр от RR.

## Исходники и сборка

| Каталог | Назначение |
| --- | --- |
| `sources/remix` + `patches/remix.patch` | GMod fork Remix с native NR, HDR-преобразованием и `remix_nvngx` shim |
| `sources/reshade` + `patches/reshade.patch` | ReShade с поддержкой HideSplash для старого профиля |
| `sources/bridge` + `patches/bridge.patch` | GMod-совместимый DLSS 5 bridge и переносимый поиск Visual Studio |
| `sources/fixes` | Исходники GMod RTX Remixed; локальная Lua-правка поставляется в `payload/common` |
| `tools/hl2rtx-mount` | Проверяемый монтаж ресурсов HL2 RTX и USDA fixes |
| `config/engine-patches.json` | Точные входные/выходные хеши и 47 изменяемых байтов движка |
| `config/artifacts.json`, `config/payload-files.json` | Происхождение и хеши архивов, DLL и настроек |

Ревизии исходников закреплены Git submodule gitlinks; `.gitmodules` содержит публичные upstream URL. Наши изменения хранятся отдельными полными патчами, включая новые файлы. Подготовка не делает reset и отказывается уничтожать посторонние правки:

```powershell
git lfs fsck
bun run sources:prepare
bun run sources:verify
bun run typecheck
bun run build:native -- -CheckOnly
bun run build:legacy -- -CheckOnly
```

Для native-сборки нужны Visual Studio C++ x64, **MSVC 14.41**, Windows SDK, Python, Meson и Ninja. Публичные SDK загружает Packman. Нужные публичные вложенные submodule подготавливает `sources:prepare`; отсутствующие закрытые тестовые зависимости NVIDIA исключены в Meson. Для legacy дополнительно нужен pip.

```powershell
bun run build:native
bun run build:legacy
```

Каждая команда обновляет только свои две DLL в `payload` и их хеши в манифесте; сборки выполняй последовательно. Игра не изменяется до отдельного `setup --apply`. Скрипты сборки прошли preflight; исходные DLL собраны из сохранённых исходников. Повторная полная сборка из новой папки и побитовое совпадение MSVC-выходов не заявляются.

Native NR перенесён из [lunks/dxvk-remix-plus-dlssnr, fc4de144](https://github.com/lunks/dxvk-remix-plus-dlssnr/commit/fc4de144b38e3af508ed99a99864d0a6dc26fa35) в [GMod fork Remix](https://github.com/sambow23/dxvk-remix-gmod). `nvngx_dlssnr.dll` сохранён с действительной подписью NVIDIA без изменения подписанного кода. Его внутренние исходники отсутствуют. Исходники закрытого RenoDX DLSS 5 provider также отсутствуют; имеющийся общий RenoDX upstream не позволяет пересобрать этот provider. Точные версии и ограничения происхождения указаны в манифесте. Лицензии открытых частей лежат в исходниках и payload; проект не следует автоматически публиковать целиком.

## Известные ограничения

Чёрная вода и отдельные проблемы освещения моделей на некоторых картах остаются отдельными несовершенствами GMod RTX. В комплекте сохранено исправление исчезновения моделей при HL2 RTX mount (`r_forcehwskin 0` и отложенное восстановление настройки), но это не полное исправление всех материалов и моделей. Компиляция шейдеров при первом запуске может занимать заметное время: `dxvk.numCompilerThreads = 1` сохранён из проверенной конфигурации для устойчивого старта.
