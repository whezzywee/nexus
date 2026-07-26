package turnacceptance

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	turnRealm       = "nexus.local"
	credentialToken = "nexus-turn-acceptance"
)

type turnCredential struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	ExpiresAt  int64    `json:"expiresAt"`
}

func mintCredential(secret []byte, now time.Time, ttl time.Duration) turnCredential {
	username := fmt.Sprintf("%d:nexus-acceptance", now.Add(ttl).Unix())
	mac := hmac.New(sha1.New, secret)
	_, _ = io.WriteString(mac, username)
	return turnCredential{
		Username:   username,
		Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		ExpiresAt:  now.Add(ttl).UnixMilli(),
	}
}

func validateCredential(secret []byte, username, credential string, now time.Time) bool {
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 {
		return false
	}
	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || expiry <= now.Unix() || expiry > now.Add(time.Hour).Unix() {
		return false
	}
	expected := mintCredential(secret, time.Unix(expiry, 0).Add(-5*time.Minute), 5*time.Minute)
	return subtle.ConstantTimeCompare([]byte(expected.Credential), []byte(credential)) == 1
}

type acceptanceService struct {
	server     *turn.Server
	credential *httptest.Server
	turnURL    string
}

func startAcceptanceService(t *testing.T) *acceptanceService {
	t.Helper()
	secret := []byte("local-only-turn-rest-secret-32-bytes")
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.LocalAddr().(*net.UDPAddr).Port
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: turnRealm,
		AuthHandler: func(request *turn.RequestAttributes) (string, []byte, bool) {
			mac := hmac.New(sha1.New, secret)
			_, _ = io.WriteString(mac, request.Username)
			password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
			if !validateCredential(secret, request.Username, password, time.Now()) {
				return "", nil, false
			}
			return request.Username, turn.GenerateAuthKey(request.Username, turnRealm, password), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: listener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP("127.0.0.1"),
				Address:      "127.0.0.1",
			},
		}},
	})
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	turnURL := fmt.Sprintf("turn:127.0.0.1:%d?transport=udp", port)
	credentialServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/turn-credentials" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+credentialToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		credential := mintCredential(secret, time.Now(), 5*time.Minute)
		credential.URLs = []string{turnURL}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(credential)
	}))
	service := &acceptanceService{
		server:     server,
		credential: credentialServer,
		turnURL:    turnURL,
	}
	t.Cleanup(func() {
		credentialServer.Close()
		if err := server.Close(); err != nil {
			t.Errorf("close TURN server: %v", err)
		}
	})
	return service
}

func fetchCredential(t *testing.T, service *acceptanceService) turnCredential {
	t.Helper()
	request, err := http.NewRequestWithContext(
		context.Background(),
		http.MethodGet,
		service.credential.URL+"/turn-credentials",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+credentialToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("credential endpoint returned %s", response.Status)
	}
	var credential turnCredential
	if err := json.NewDecoder(response.Body).Decode(&credential); err != nil {
		t.Fatal(err)
	}
	if credential.ExpiresAt <= time.Now().Add(30*time.Second).UnixMilli() ||
		credential.ExpiresAt > time.Now().Add(time.Hour).UnixMilli() {
		t.Fatal("credential is not short-lived")
	}
	return credential
}

type peerPair struct {
	left       *webrtc.PeerConnection
	right      *webrtc.PeerConnection
	leftTrack  *webrtc.TrackLocalStaticSample
	rightTrack *webrtc.TrackLocalStaticSample
	candidates []string
	mu         sync.Mutex
}

func connectPair(t *testing.T, configuration webrtc.Configuration, label string) *peerPair {
	t.Helper()
	left, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		t.Fatal(err)
	}
	right, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		_ = left.Close()
		t.Fatal(err)
	}
	pair := &peerPair{left: left, right: right}
	t.Cleanup(func() {
		_ = left.Close()
		_ = right.Close()
	})
	left.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			pair.mu.Lock()
			pair.candidates = append(pair.candidates, candidate.ToJSON().Candidate)
			pair.mu.Unlock()
		}
	})
	right.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			pair.mu.Lock()
			pair.candidates = append(pair.candidates, candidate.ToJSON().Candidate)
			pair.mu.Unlock()
		}
	})

	leftMedia := make(chan struct{}, 1)
	rightMedia := make(chan struct{}, 1)
	left.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if _, _, err := track.ReadRTP(); err == nil {
			leftMedia <- struct{}{}
		}
	})
	right.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if _, _, err := track.ReadRTP(); err == nil {
			rightMedia <- struct{}{}
		}
	})
	pair.leftTrack, err = webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		"audio",
		"left-"+label,
	)
	if err != nil {
		t.Fatal(err)
	}
	pair.rightTrack, err = webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		"audio",
		"right-"+label,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := left.AddTrack(pair.leftTrack); err != nil {
		t.Fatal(err)
	}
	if _, err := right.AddTrack(pair.rightTrack); err != nil {
		t.Fatal(err)
	}

	received := make(chan string, 1)
	right.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			received <- string(message.Data)
		})
	})
	dataChannel, err := left.CreateDataChannel("nexus-acceptance", nil)
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{}, 1)
	dataChannel.OnOpen(func() {
		opened <- struct{}{}
	})

	offer, err := left.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	leftGathering := webrtc.GatheringCompletePromise(left)
	if err := left.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-leftGathering
	if err := right.SetRemoteDescription(*left.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := right.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	rightGathering := webrtc.GatheringCompletePromise(right)
	if err := right.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-rightGathering
	if err := left.SetRemoteDescription(*right.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	select {
	case <-opened:
	case <-time.After(15 * time.Second):
		t.Fatal("data channel did not open")
	}
	message := "nexus-" + label
	if err := dataChannel.SendText(message); err != nil {
		t.Fatal(err)
	}
	select {
	case actual := <-received:
		if actual != message {
			t.Fatalf("received %q, expected %q", actual, message)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("data channel message did not arrive")
	}

	silence := media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}
	for range 3 {
		if err := pair.leftTrack.WriteSample(silence); err != nil {
			t.Fatal(err)
		}
		if err := pair.rightTrack.WriteSample(silence); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-leftMedia:
	case <-time.After(5 * time.Second):
		t.Fatal("left peer did not receive relayed audio RTP")
	}
	select {
	case <-rightMedia:
	case <-time.After(5 * time.Second):
		t.Fatal("right peer did not receive relayed audio RTP")
	}
	return pair
}

func TestTurnRestCredentialsAndMediaRoutes(t *testing.T) {
	service := startAcceptanceService(t)
	unauthorized, err := http.Get(service.credential.URL + "/turn-credentials")
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("credential endpoint accepted an unauthenticated request: %s", unauthorized.Status)
	}
	credential := fetchCredential(t, service)
	relayConfiguration := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{
			URLs:           credential.URLs,
			Username:       credential.Username,
			Credential:     credential.Credential,
			CredentialType: webrtc.ICECredentialTypePassword,
		}},
		ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	}

	direct := connectPair(t, webrtc.Configuration{}, "direct-two-party")
	if !containsCandidateType(direct.candidates, "host") {
		t.Fatal("direct acceptance did not gather a host candidate")
	}
	relayed := connectPair(t, relayConfiguration, "relay-two-party")
	if !onlyCandidateType(relayed.candidates, "relay") {
		t.Fatalf("relay-only acceptance gathered non-relay candidates: %v", relayed.candidates)
	}

	for _, edge := range []string{"alice-bob", "alice-carol", "bob-carol"} {
		meshPair := connectPair(t, relayConfiguration, "mesh-"+edge)
		if !onlyCandidateType(meshPair.candidates, "relay") {
			t.Fatalf("%s gathered non-relay candidates: %v", edge, meshPair.candidates)
		}
	}
}

func containsCandidateType(candidates []string, candidateType string) bool {
	for _, candidate := range candidates {
		if strings.Contains(candidate, " typ "+candidateType+" ") {
			return true
		}
	}
	return false
}

func onlyCandidateType(candidates []string, candidateType string) bool {
	if len(candidates) == 0 {
		return false
	}
	for _, candidate := range candidates {
		if !strings.Contains(candidate, " typ "+candidateType+" ") {
			return false
		}
	}
	return true
}
