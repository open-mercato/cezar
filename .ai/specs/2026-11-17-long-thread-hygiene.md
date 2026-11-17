# Karta zadania — higiena długich wątków cezara

Status: do zatwierdzenia przez Kamila; po niezależnej kontroli fe01e743 i uzupełnieniu ustaleń.

**Po co:** ograniczyć koszt rozrośniętych wątków i ułatwić dalszą pracę w świeżym wątku, zachowując dostęp do wartościowych efektów poprzednika.

**Co zobaczysz, gdy będzie gotowe:**
1. Osobna akcja „Status” odczytuje zapisany stan zadania i handoff: wynik, blokady, następny krok oraz datę aktualizacji treści. Nie uruchamia modelu; brak informacji pokazuje jako „brak danych”. Swobodna wiadomość w czacie pozostaje wiadomością do agenta.
2. Przed czwartą i każdą kolejną kontynuacją pracy pojawia się wybór „Kontynuuj pracę” / „Przygotuj przekazanie”. Dotyczy również automatu: czeka on na decyzję, bez płatnego turnu. Zgoda dotyczy jednego wznowienia i nie odnawia budżetu ani innych zgód; obowiązki AGENTS.md nadal obowiązują.
3. Licznik obejmuje przyjęte wznowienia pracy, także wiadomością do zaparkowanego wątku oraz automatycznie. Nie obejmuje pierwszego uruchomienia, statusu, otwarcia widoku, wiadomości podczas trwającej pracy, ponowienia tej samej operacji, odzyskania po awarii, kompaktacji ani kontroli PR bez turnu modelu. Jest trwały, z przyczyną i identyfikatorem operacji. Niepewna historia pokazuje brak danych; nie wyliczamy jej z samej liczby sesji.
4. Manager pokazuje wyjątek przy próbie powrotu do pracy. Sam uśpiony długi wątek nie tworzy alarmu. Informacja omija płatne attention/watch i powiadomienia systemowe; inne wyjątki działają jak dotąd.
5. Bramka nie zatrzymuje aktywnych dzieci i zachowuje ich raporty bez płatnej kontynuacji rodzica. Pokazuje oczekiwanie na decyzję i stan dzieci. Nie oznacza rodzica jako ukończonego, nie gubi odpowiedzialności ani wyników. Jeżeli istniejący kontrakt uniemożliwi bezpieczny nadzór, zgłaszamy blokadę przed uruchomieniem zmian.
6. „Przygotuj przekazanie” jawnie zleca agentowi zapisanie materiału: celu, kryterium końca, faktycznie gotowego stanu, pierwszego kroku następcy, blokad, otwartych decyzji, granic zgód, pozostałego budżetu, liczby kontynuacji oraz gałęzi/PR i sposobu wznowienia pracy. To płatna praca dopiero po wyborze użytkownika; nie obchodzi istniejących limitów.
7. Materiał wskazuje wybrane efekty poprzednika, np. wczesną makietę UI, zaakceptowany wariant lub wynik testu — z opisem „po co otworzyć”. Manifest wskazuje konkretną wersję lub zachowaną kopię wraz z zależnościami, np. obrazami makiety. Sprawdzamy odczyt przez następcę również dla plików spoza Git i później nadpisanych oryginałów; brak jawnie oznaczamy. Nie usuwamy oryginałów i nie kopiujemy całej rozmowy.
8. Materiał trafia do sprawdzenia przez użytkownika. Nowy wątek wymaga osobnej akcji; samo przygotowanie go nie tworzy ani nie uruchamia. Poprzednik nie kończy odpowiedzialności przed zaakceptowanym przekazaniem.

**Czego NIE robimy:** automatycznego budzenia uśpionych wątków, automatycznego przekazywania lub zamykania pracy, progów tokenów i wieku wątku, zmiany AGENTS.md, budżetów ani globalnego wyłączania automatyzacji. Nie rozpoznajemy dowolnego pytania tekstowego o status jako bezpłatnej akcji. Nie zmieniamy zainstalowanego pakietu w miejscu.

**Decyzje właściciela:** przygotować kartę; status bez budzenia; próg trzech kontynuacji; wyjątek managera przy powrocie; przekazanie skupione na dalszej pracy i odwołaniach do efektów poprzednika; automatyczna czwarta kontynuacja czeka na decyzję.

**Jak sprawdzimy:** testy granicy 3/4, ręcznych i automatycznych ścieżek, duplikatów, restartu, niepewnej historii i wyłączeń licznika; brak wywołań modeli dla statusu, bramki i wyjątku managera także przy aktywnym harmonogramie; raport dziecka przy zatrzymanym rodzicu; przygotowanie bez utworzenia następcy; otwarcie zachowanej wersji makiety i jej obrazów przez następcę; lokalny smoke UI na desktopie i wąskim ekranie oraz wymagane bramki repozytorium cezara. Wyniki i ograniczenia w PR/raporcie.

**Ryzyko i jak cofnąć:** błędne zliczanie, zatrzymanie potrzebnej kontynuacji, utrata odwołań. Testy obejmą te scenariusze; cofnięcie kodu przez revert PR. Uruchomienie i rollback działającej wersji wymagają osobnego planu i zgody.

**Potrzebne zgody i dostawa:** zatwierdzenie tej karty pozwala implementować i przygotować zmiany do przeglądu, bez instalacji ani restartu działającego cockpitu. Upstream open-mercato/cezar jest dostępny tylko z READ; brak źródłowego checkoutu w znanych projektach. Przed kodowaniem sprawdzimy zasady upstream, szczegółowe nakładanie prac i bezpieczny checkout dla tego zadania. Dostawa: sprawdzony PR, jeśli uprawnienia pozwolą, albo patch z bazowym SHA i komendami weryfikacji, z jawnym ograniczeniem. Instalacja i uruchomienie wymagają osobnej zgody Kamila.

Rozpoznanie: działający pakiet 0.20.0; upstream main odczytany jako 75d643737ba1801317cf5942484e6d0a1b2d4609. Kontrola niezależna: artifacts/fe01e743-fb21-4500-883c-c22d1c4fb7ec/challenge-karty.md. Powiązane upstream PR-y 1180, 1820, 1954, 2225 wymagają szczegółowego sprawdzenia nakładania przed zmianami. Nie zmieniono źródeł ani działania cockpitu.


## Implementation limitation (pending owner acceptance)

Preparing a handoff is safely refused while a graph child-wait node has no parent agent session. Reports remain retained and explicit Continue is available. The UI returns a clear refusal; it does not create another task or silently continue work. This exception must be accepted by the owner before treating the complete card as delivered or installing the patch.
